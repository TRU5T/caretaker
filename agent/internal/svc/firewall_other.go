//go:build !windows

package svc

func configureFirewall(string, int, string) {}

func removeFirewall() {}
