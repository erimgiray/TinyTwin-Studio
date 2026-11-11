//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func openWindow(url string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", url).Start()
		return
	}
	if exec.Command("xdg-open", url).Start() != nil {
		fmt.Println("Open", url)
	}
}

func openPath(p string) { openWindow(p) }

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
