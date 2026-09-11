package svc

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/kardianos/service"
	"github.com/sam/caretaker/agent/internal/agent"
	"github.com/sam/caretaker/agent/internal/config"
)

type program struct {
	cfgPath string
	cfg     *config.Config
	server  *http.Server
	stop    chan struct{}
}

func (p *program) Start(_ service.Service) error {
	go p.run()
	return nil
}

func (p *program) run() {
	defer func() {
		if v := recover(); v != nil {
			agent.Logf("PANIC in service run: %v\n%s", v, debug.Stack())
		}
	}()

	logPath := filepath.Join(filepath.Dir(p.cfgPath), "agent.log")
	agent.SetLogPath(logPath)
	if err := agent.RedirectCrashOutput(filepath.Join(filepath.Dir(p.cfgPath), "agent-crash.log")); err != nil {
		agent.Logf("service: crash log unavailable: %v", err)
	}
	agent.Logf("service start pid=%d listen=%s paired=%v log=%s", os.Getpid(), p.cfg.ListenAddr, p.cfg.Token != "" && p.cfg.HostID != "", logPath)

	p.stop = make(chan struct{})
	srv := agent.NewServer(p.cfgPath, p.cfg)
	agent.SafeGo("heartbeat", func() { srv.StartHeartbeat(p.stop) })
	agent.SafeGo("beacon", func() { srv.StartBeacon(p.stop) })

	p.server = &http.Server{
		Addr:              p.cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	fmt.Printf("caretaker-agent v%s listening on %s (paired=%v)\n", agent.Version, p.cfg.ListenAddr, p.cfg.Token != "" && p.cfg.HostID != "")
	go p.logAlive()

	// Always record why the listener stopped, so a silent exit is never a mystery.
	err := p.server.ListenAndServe()
	if err == http.ErrServerClosed {
		agent.Logf("service stop: listener closed cleanly")
	} else {
		agent.Logf("service stop: listener exited: %v", err)
	}
}

// logAlive writes a periodic marker so an absent log means "died", not "idle".
func (p *program) logAlive() {
	t := time.NewTicker(1 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-t.C:
			agent.Logf("alive")
		}
	}
}

func (p *program) Stop(_ service.Service) error {
	if p.stop != nil {
		select {
		case <-p.stop:
		default:
			close(p.stop)
		}
	}
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = p.server.Shutdown(ctx)
	}
	return nil
}

func newService(cfgPath string, cfg *config.Config) (service.Service, *program, error) {
	svcConfig := &service.Config{
		Name:        "CaretakerAgent",
		DisplayName: "Caretaker Agent",
		Description: "Moonlight/Apollo companion — sleep, unlock, heartbeat for Caretaker Hub",
	}
	prg := &program{cfgPath: cfgPath, cfg: cfg}
	s, err := service.New(prg, svcConfig)
	return s, prg, err
}

func Run(cfgPath string, cfg *config.Config) error {
	s, prg, err := newService(cfgPath, cfg)
	if err != nil {
		return err
	}
	if !service.Interactive() {
		return s.Run()
	}

	stop := make(chan struct{})
	defer close(stop)
	logPath := filepath.Join(filepath.Dir(cfgPath), "agent.log")
	agent.SetLogPath(logPath)
	agent.Logf("foreground start listen=%s paired=%v", cfg.ListenAddr, cfg.Token != "" && cfg.HostID != "")
	srv := agent.NewServer(cfgPath, cfg)
	go srv.StartHeartbeat(stop)
	go srv.StartBeacon(stop)

	httpServer := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	prg.server = httpServer

	errCh := make(chan error, 1)
	go func() {
		fmt.Printf("caretaker-agent v%s listening on %s (paired=%v)\n", agent.Version, cfg.ListenAddr, cfg.Token != "" && cfg.HostID != "")
		if cfg.Token == "" {
			fmt.Println("unpaired — broadcasting on LAN; pair from the Caretaker Hub UI")
		}
		errCh <- httpServer.ListenAndServe()
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
		return nil
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func Control(action string) error {
	path := config.DefaultPath()
	cfg, err := config.LoadOrCreate(path)
	if err != nil {
		return err
	}
	s, _, err := newService(path, cfg)
	if err != nil {
		return err
	}
	if err := service.Control(s, action); err != nil {
		return err
	}
	if action == "install" {
		configureRestartOnFailure("CaretakerAgent")
	}
	return nil
}
