//go:build !windows

package svc

func configureFirewall(string) {}

func removeFirewall() {}
