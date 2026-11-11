//go:build windows

package main

import (
	"log"
	"path/filepath"
	"runtime"

	webview2 "github.com/jchv/go-webview2"
)

func init() { runtime.LockOSThread() } // the window must live on the main OS thread

// runNativeWindow shows the UI in TinyTwin's own window using the WebView2 engine
// built into Windows 10/11. Returns false if WebView2 isn't available.
func runNativeWindow(url string) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Println("webview2 failed:", r)
			ok = false
		}
	}()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  filepath.Join(dataDir, "webview"),
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  1440,
			Height: 920,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		log.Println("webview2 unavailable, falling back to browser window")
		return false
	}
	noExit = true // lifetime is tied to this window, not the heartbeat
	w.SetSize(1100, 700, webview2.HintMin)
	w.Navigate(url)
	w.Run()
	w.Destroy()
	return true
}
