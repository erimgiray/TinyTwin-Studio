package main

// Part kit storage: <data>/kit/kit.json + base.glb + parts/*.glb, and a download proxy
// so the UI can load remote models (e.g. Higgsfield results) without CORS issues.

import (
	"archive/zip"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

func kitDir() string { return filepath.Join(dataDir, "kit") }

func kitRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/kit", func(w http.ResponseWriter, r *http.Request) {
		f := filepath.Join(kitDir(), "kit.json")
		switch r.Method {
		case http.MethodGet:
			b, err := os.ReadFile(f)
			if err != nil {
				b = []byte("null")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		case http.MethodPut:
			b, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			os.MkdirAll(kitDir(), 0o755)
			os.WriteFile(f+".tmp", b, 0o644)
			os.Rename(f+".tmp", f)
			w.WriteHeader(204)
		default:
			http.Error(w, "method", 405)
		}
	})
	mux.HandleFunc("/api/kit/file", func(w http.ResponseWriter, r *http.Request) {
		name := cleanRel(r.URL.Query().Get("name"))
		if name == "" || strings.Contains(name, "..") {
			http.Error(w, "bad name", 400)
			return
		}
		p := filepath.Join(kitDir(), filepath.FromSlash(name))
		switch r.Method {
		case http.MethodPost:
			os.MkdirAll(filepath.Dir(p), 0o755)
			o, err := os.Create(p)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			_, err = io.Copy(o, io.LimitReader(r.Body, 300<<20))
			o.Close()
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			writeJSON(w, map[string]string{"url": "/data/kit/" + name + "?v=" + time.Now().Format("150405")})
		case http.MethodDelete:
			os.Remove(p)
			w.WriteHeader(204)
		default:
			http.Error(w, "method", 405)
		}
	})
	mux.HandleFunc("/api/kit/import", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		zp, err := incomingZip(r)
		defer os.Remove(zp)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		tmp := kitDir() + ".new"
		os.RemoveAll(tmp)
		n, err := extractZip(zp, tmp, func(name string) (string, bool) {
			// accept an optional wrapper folder around kit.json
			segs := strings.Split(name, "/")
			for i := range segs {
				rest := strings.Join(segs[i:], "/")
				if rest == "kit.json" || strings.HasPrefix(rest, "parts/") || strings.HasPrefix(rest, "bodies/") || rest == "base.glb" || strings.HasPrefix(rest, "views/") || strings.HasPrefix(rest, "paint/") || strings.HasPrefix(rest, "standards/") {
					return rest, true
				}
			}
			return "", false
		})
		if err != nil || n == 0 {
			os.RemoveAll(tmp)
			if err == nil {
				http.Error(w, "That zip doesn't contain a TinyTwin part kit (kit.json).", 400)
			} else {
				http.Error(w, err.Error(), 400)
			}
			return
		}
		if _, err := os.Stat(filepath.Join(tmp, "kit.json")); err != nil {
			os.RemoveAll(tmp)
			http.Error(w, "That zip doesn't contain a TinyTwin part kit (kit.json).", 400)
			return
		}
		old := kitDir() + ".old"
		os.RemoveAll(old)
		os.Rename(kitDir(), old)
		if err := os.Rename(tmp, kitDir()); err != nil {
			os.Rename(old, kitDir())
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/kit/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		os.RemoveAll(kitDir() + ".old")
		os.Rename(kitDir(), kitDir()+".old")
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/kit/zip", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="tinytwin-part-kit.zip"`)
		zw := zip.NewWriter(w)
		filepath.WalkDir(kitDir(), func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(kitDir(), p)
			fh := &zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate}
			if st, e := d.Info(); e == nil {
				fh.Modified = st.ModTime()
			}
			f, err := zw.CreateHeader(fh)
			if err != nil {
				return err
			}
			src, err := os.Open(p)
			if err == nil {
				io.Copy(f, src)
				src.Close()
			}
			return nil
		})
		zw.Close()
	})
	// Stream a remote file through the local server (https only).
	mux.HandleFunc("/api/fetch", func(w http.ResponseWriter, r *http.Request) {
		u := r.URL.Query().Get("url")
		testLocal := os.Getenv("TINYTWIN_UPDATE_API") != "" && strings.HasPrefix(u, "http://127.0.0.1:")
		if !strings.HasPrefix(u, "https://") && !testLocal {
			http.Error(w, "only https links are allowed", 400)
			return
		}
		resp, err := (&http.Client{Timeout: 10 * time.Minute}).Get(u)
		if err != nil {
			http.Error(w, "download failed: "+err.Error(), 502)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			http.Error(w, "download failed: "+resp.Status, 502)
			return
		}
		ext := strings.ToLower(path.Ext(strings.SplitN(u, "?", 2)[0]))
		ct := resp.Header.Get("Content-Type")
		if ext == ".glb" {
			ct = "model/gltf-binary"
		}
		if ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		io.Copy(w, resp.Body)
	})
}
