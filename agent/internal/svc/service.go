package svc

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/TRU5T/caretaker/agent/internal/agent"
	"github.com/TRU5T/caretaker/agent/internal/config"
	"github.com/kardianos/service"
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
	agent.Logf("service start pid=%d listen=%s paired=%v log=%s", os.Getpid(), p.cfg.ListenAddr, p.cfg.Paired(), logPath)

	p.stop = make(chan struct{})
	srv, httpServer, err := buildServer(p.cfgPath, p.cfg)
	if err != nil {
		agent.Logf("service stop: %v", err)
		return
	}
	exe, _ := os.Executable()
	srv.OnPairingChanged = func(cfg config.Config) {
		if exe != "" {
			configureFirewall(exe, srv.ListenPort(), firewallScope(cfg))
		}
	}
	srv.OnPairingChanged(*p.cfg)
	agent.SafeGo("heartbeat", func() { srv.StartHeartbeat(p.stop) })
	agent.SafeGo("beacon", func() { srv.StartBeacon(p.stop) })

	p.server = httpServer
	fmt.Printf("caretaker-agent v%s listening on %s (TLS, paired=%v)\n", agent.Version, p.cfg.ListenAddr, p.cfg.Paired())
	go p.logAlive()

	// Always record why the listener stopped, so a silent exit is never a mystery.
	err = p.server.ListenAndServeTLS("", "")
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

// buildServer prepares the TLS certificate, the pairing code (if unpaired),
// and an HTTPS server for the agent API.
func buildServer(cfgPath string, cfg *config.Config) (*agent.Server, *http.Server, error) {
	cert, err := config.LoadOrCreateCert(cfgPath)
	if err != nil {
		return nil, nil, fmt.Errorf("TLS certificate: %w", err)
	}
	agent.Logf("TLS certificate sha256=%s", cert.SHA256)
	if !cfg.Paired() && cfg.PairCode == "" {
		code, err := config.NewPairCode()
		if err != nil {
			return nil, nil, err
		}
		cfg.PairCode = code
		if err := config.Save(cfgPath, cfg); err != nil {
			return nil, nil, fmt.Errorf("save pairing code: %w", err)
		}
	}
	if !cfg.Paired() {
		agent.Logf("unpaired — pairing code: %s (enter it in the Hub when you tap Pair)", config.FormatPairCode(cfg.PairCode))
	}
	srv := agent.NewServer(cfgPath, cfg, cert)
	return srv, &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert.TLS},
			MinVersion:   tls.VersionTLS12,
		},
	}, nil
}

// firewallScope narrows inbound access to the hub's address once paired.
// A hub URL with a DNS name falls back to the local subnet.
func firewallScope(cfg config.Config) string {
	if cfg.Paired() && cfg.HubURL != "" {
		if u, err := url.Parse(cfg.HubURL); err == nil {
			if ip := net.ParseIP(u.Hostname()); ip != nil {
				return ip.String()
			}
		}
	}
	return "localsubnet"
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

func newService(cfgPath string, cfg *config.Config, executable string) (service.Service, *program, error) {
	svcConfig := &service.Config{
		Name:        "CaretakerAgent",
		DisplayName: "Caretaker Agent",
		Description: "Moonlight/Apollo companion — sleep, unlock, heartbeat for Caretaker Hub",
		Executable:  executable,
		Arguments:   []string{"run", "--config", cfgPath},
	}
	prg := &program{cfgPath: cfgPath, cfg: cfg}
	s, err := service.New(prg, svcConfig)
	return s, prg, err
}

func Run(cfgPath string, cfg *config.Config) error {
	s, prg, err := newService(cfgPath, cfg, "")
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
	agent.Logf("foreground start listen=%s paired=%v", cfg.ListenAddr, cfg.Paired())
	srv, httpServer, err := buildServer(cfgPath, cfg)
	if err != nil {
		return err
	}
	go srv.StartHeartbeat(stop)
	go srv.StartBeacon(stop)
	prg.server = httpServer

	errCh := make(chan error, 1)
	go func() {
		fmt.Printf("caretaker-agent v%s listening on %s (TLS, paired=%v)\n", agent.Version, cfg.ListenAddr, cfg.Paired())
		if !cfg.Paired() {
			fmt.Printf("unpaired — broadcasting on LAN. Pairing code: %s\n", config.FormatPairCode(cfg.PairCode))
		}
		errCh <- httpServer.ListenAndServeTLS("", "")
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
	s, _, err := newService(path, cfg, "")
	if err != nil {
		return err
	}
	if err := service.Control(s, action); err != nil {
		return err
	}
	if action == "install" {
		configureRestartOnFailure("CaretakerAgent")
		if exe, err := os.Executable(); err == nil {
			configureFirewall(exe, listenPort(cfg), firewallScope(*cfg))
		}
	}
	if action == "uninstall" {
		removeFirewall()
	}
	return nil
}

// StopIfRunning stops the Windows service when it is installed and running.
func StopIfRunning() {
	s, err := serviceHandle("")
	if err != nil {
		return
	}
	st, err := s.Status()
	if err == nil && st == service.StatusRunning {
		_ = s.Stop()
	}
}

// InstallAndStart registers the service to run executable (empty = this process),
// then starts it. Safe to call when the service already exists.
func InstallAndStart(executable string) error {
	s, err := serviceHandle(executable)
	if err != nil {
		return err
	}
	if st, err := s.Status(); err == nil && st == service.StatusRunning {
		_ = s.Stop()
		time.Sleep(400 * time.Millisecond)
	}
	if err := s.Install(); err != nil {
		if !alreadyInstalled(err) {
			return err
		}
		_ = s.Uninstall()
		time.Sleep(400 * time.Millisecond)
		if err := s.Install(); err != nil {
			return err
		}
	}
	configureRestartOnFailure("CaretakerAgent")
	exe := executable
	if exe == "" {
		exe, _ = os.Executable()
	}
	if exe != "" {
		if cfg, err := config.LoadOrCreate(config.DefaultPath()); err == nil {
			configureFirewall(exe, listenPort(cfg), firewallScope(*cfg))
		}
	}
	return s.Start()
}

// Restart stops the service if it is running and starts it again so it
// picks up config written by the CLI (pair / unpair).
func Restart() error {
	s, err := serviceHandle("")
	if err != nil {
		return err
	}
	if st, err := s.Status(); err != nil || st != service.StatusRunning {
		return nil // not installed or not running: nothing to reload
	}
	if err := s.Stop(); err != nil {
		return err
	}
	time.Sleep(500 * time.Millisecond)
	return s.Start()
}

func listenPort(cfg *config.Config) int {
	if _, port, err := net.SplitHostPort(cfg.ListenAddr); err == nil {
		var p int
		if _, err := fmt.Sscanf(port, "%d", &p); err == nil && p > 0 {
			return p
		}
	}
	return config.DefaultPort
}

// UninstallService stops and deletes the Windows service. Missing service is OK.
func UninstallService() error {
	s, err := serviceHandle("")
	if err != nil {
		return err
	}
	_ = s.Stop()
	err = s.Uninstall()
	removeFirewall()
	if err != nil && !notInstalled(err) {
		return err
	}
	return nil
}

func serviceHandle(executable string) (service.Service, error) {
	path := config.DefaultPath()
	cfg, err := config.LoadOrCreate(path)
	if err != nil {
		return nil, err
	}
	s, _, err := newService(path, cfg, executable)
	return s, err
}

func alreadyInstalled(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "already exists") || strings.Contains(s, "already installed")
}

func notInstalled(err error) bool {
	if err == nil {
		return false
	}
	if err == service.ErrNotInstalled {
		return true
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "not installed") || strings.Contains(s, "does not exist")
}
