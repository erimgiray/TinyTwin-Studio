//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

func browserCandidates() []string {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	local := os.Getenv("LOCALAPPDATA")
	return []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf, `BraveSoftware\Brave-Browser\Application\brave.exe`),
	}
}

// openWindow opens the UI as its own app window (no tabs or address bar).
func openWindow(url string) {
	profile := filepath.Join(dataDir, "browser")
	for _, b := range browserCandidates() {
		if _, err := os.Stat(b); err != nil {
			continue
		}
		cmd := exec.Command(b, "--app="+url, "--user-data-dir="+profile, "--window-size=1440,920",
			"--no-first-run", "--no-default-browser-check", "--disable-features=Translate")
		if cmd.Start() == nil {
			return
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func openPath(p string) {
	exec.Command("explorer", p).Start()
}

func fatal(msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	mb := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(appName)
	m, _ := syscall.UTF16PtrFromString(msg)
	mb.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
	os.Exit(1)
}
