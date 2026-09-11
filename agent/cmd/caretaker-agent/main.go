package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/sam/caretaker/agent/internal/agent"
	"github.com/sam/caretaker/agent/internal/config"
	"github.com/sam/caretaker/agent/internal/pair"
	"github.com/sam/caretaker/agent/internal/svc"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "pair":
			pairCmd(os.Args[2:])
			return
		case "run":
			runCmd(os.Args[2:])
			return
		case "unlock-helper":
			unlockHelperCmd()
			return
		case "install", "uninstall", "start", "stop":
			if err := svc.Control(os.Args[1]); err != nil {
				fatal(err)
			}
			return
		case "version":
			fmt.Println(agent.Version)
			return
		case "help", "-h", "--help":
			printHelp()
			return
		}
	}

	// Default: run in foreground (also used by Windows service)
	runCmd(os.Args[1:])
}

func runCmd(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	cfgPath := fs.String("config", config.DefaultPath(), "path to agent config.json")
	_ = fs.Parse(args)

	cfg, err := config.LoadOrCreate(*cfgPath)
	if err != nil {
		fatal(err)
	}

	if err := svc.Run(*cfgPath, cfg); err != nil {
		fatal(err)
	}
}

func pairCmd(args []string) {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	hub := fs.String("hub", "", "hub base URL, e.g. http://10.0.1.10:8080")
	code := fs.String("code", "", "pairing code from hub UI")
	agentURL := fs.String("agent-url", "", "how the hub reaches this agent, e.g. http://10.0.1.50:7842")
	mac := fs.String("mac", "", "optional MAC override (hub already has it from Add PC)")
	name := fs.String("name", "", "optional display name override")
	cfgPath := fs.String("config", config.DefaultPath(), "path to write agent config.json")
	_ = fs.Parse(args)

	if err := pair.Complete(pair.Options{
		HubURL:     *hub,
		Code:       *code,
		AgentURL:   *agentURL,
		MAC:        *mac,
		Name:       *name,
		ConfigPath: *cfgPath,
	}); err != nil {
		fatal(err)
	}
	fmt.Println("pairing complete; config written to", *cfgPath)
}

func unlockHelperCmd() {
	// Always log helper steps next to the service log.
	logPath := filepath.Join(filepath.Dir(config.DefaultPath()), "agent.log")
	agent.SetLogPath(logPath)
	agent.Logf("unlock-helper: process start pid=%d", os.Getpid())

	// stdin: "<kind>\n<secret>\n" — kind may be prepare|pin|password
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		agent.Logf("unlock-helper: stdin read failed: %v", err)
		fatal(err)
	}
	parts := strings.SplitN(string(data), "\n", 3)
	kind := "pin"
	secret := ""
	if len(parts) >= 1 {
		kind = strings.TrimSpace(strings.TrimRight(parts[0], "\r"))
	}
	if len(parts) >= 2 {
		secret = strings.TrimRight(parts[1], "\r")
	}
	agent.Logf("unlock-helper: kind=%s secretLen=%d", kind, len(secret))
	if kind == "prepare" {
		if err := agent.UnlockHelperPrepare(); err != nil {
			agent.Logf("unlock-helper: prepare failed: %v", err)
			fatal(err)
		}
		agent.Logf("unlock-helper: prepare ok")
		return
	}
	if secret == "" {
		fatal(fmt.Errorf("empty secret on stdin"))
	}
	if err := agent.UnlockHelper(secret); err != nil {
		agent.Logf("unlock-helper: unlock failed: %v", err)
		fatal(err)
	}
	agent.Logf("unlock-helper: unlock ok")
}

func printHelp() {
	fmt.Print(`caretaker-agent — Windows companion for Caretaker Hub / Moonlight+Apollo

Usage:
  caretaker-agent run [--config path]
  caretaker-agent pair --hub URL --code CODE --agent-url URL [--mac MAC] [--name NAME]
  caretaker-agent install|uninstall|start|stop
  caretaker-agent version

Environment overrides:
  CARETAKER_AGENT_TOKEN   bearer token
  CARETAKER_AGENT_PORT    listen port (default 7842)
  CARETAKER_HUB_URL       optional hub for heartbeats
  CARETAKER_HOST_ID       host id assigned by hub
`)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
