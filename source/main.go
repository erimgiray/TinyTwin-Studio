// TinyTwin Studio — single-exe local app.
// Serves an embedded web UI on 127.0.0.1 and opens it in a chromeless Edge/Chrome window.
package main

import (
	"archive/zip"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed web/index.html web/app.css web/dist/app.js web/dist/worker.js web/logo.svg
var webFS embed.FS

const (
	appName     = "TinyTwin Studio"
	defaultPort = 47321
	libraryURL  = "https://d2ol7oe51mr4n9.cloudfront.net/user_3IZGj7XX0jfXEFLAWOxYQF6AtQ4/08e610c2-bc6a-44db-8f20-003ed14fd039.zip"
)

var (
	dataDir  string
	dbMu     sync.Mutex
	hbMu     sync.Mutex
	lastBeat = time.Now()
	byeAt    time.Time
	noExit   = os.Getenv("TINYTWIN_NOEXIT") == "1"
)

func main() {
	dataDir = resolveDataDir()
	for _, d := range []string{"", "jobs", "library", "models", "browser"} {
		os.MkdirAll(filepath.Join(dataDir, d), 0o755)
	}
	logf, _ := os.OpenFile(filepath.Join(dataDir, "studio.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if logf != nil {
		log.SetOutput(logf)
	}

	port := defaultPort
	if p := os.Getenv("TINYTWIN_PORT"); p != "" {
		fmt.Sscanf(p, "%d", &port)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	var err error
	ln := afterUpdate(addr)
	if ln == nil {
		ln, err = net.Listen("tcp", addr)
	}
	if err != nil {
		// Already running? Just open another window onto it.
		if c, e := http.Get("http://" + addr + "/api/ping"); e == nil {
			b, _ := io.ReadAll(c.Body)
			c.Body.Close()
			if strings.Contains(string(b), "tinytwin") {
				if !runNativeWindow("http://" + addr + "/") {
					openWindow("http://" + addr + "/")
				}
				return
			}
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("Could not start the local server: " + err.Error())
		}
	}
	url := "http://" + ln.Addr().String() + "/"
	log.Println("serving", url, "data", dataDir)

	mux := http.NewServeMux()
	routes(mux)
	srv := &http.Server{Handler: guard(ln.Addr().String(), mux)}

	go watchdog()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal(err.Error())
		}
	}()
	if os.Getenv("TINYTWIN_NOBROWSER") == "1" {
		fmt.Println(url)
		select {}
	}
	// Preferred: the app's own window (WebView2). Blocks until the window is closed.
	if runNativeWindow(url) {
		os.Exit(0)
	}
	// Fallback: chromeless browser window; the heartbeat watchdog ends the process.
	openWindow(url)
	select {}
}

func resolveDataDir() string {
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "TinyTwinData")
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p // portable mode
		}
	}
	if d := os.Getenv("TINYTWIN_DATA"); d != "" {
		return d
	}
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, appName)
	}
	d, err := os.UserConfigDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, appName)
}

// Exit once the window has been closed (no heartbeat), so the exe doesn't linger.
func watchdog() {
	for {
		time.Sleep(2 * time.Second)
		if noExit {
			continue
		}
		hbMu.Lock()
		stale := time.Since(lastBeat) > 3*time.Minute
		bye := !byeAt.IsZero() && time.Since(byeAt) > 6*time.Second && byeAt.After(lastBeat)
		hbMu.Unlock()
		if stale || bye {
			log.Println("window closed, exiting")
			os.Exit(0)
		}
	}
}

// guard blocks DNS-rebinding and cross-site requests to the local API.
func guard(host string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host && !strings.HasPrefix(r.Host, "localhost:") {
			http.Error(w, "bad host", 403)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.URL.Path != "/api/bye" {
			if r.Header.Get("X-TinyTwin") != "1" {
				http.Error(w, "missing header", 403)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

func routes(mux *http.ServeMux) {
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	}))
	mux.Handle("/data/", http.StripPrefix("/data/", http.FileServer(http.Dir(dataDir))))

	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("tinytwin")) })
	mux.HandleFunc("/api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		hbMu.Lock()
		lastBeat = time.Now()
		hbMu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/bye", func(w http.ResponseWriter, r *http.Request) {
		hbMu.Lock()
		byeAt = time.Now()
		hbMu.Unlock()
		w.WriteHeader(204)
	})
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"dataDir": dataDir, "libraryURL": libraryURL, "version": version})
	})
	kitRoutes(mux)
	mux.HandleFunc("/api/update/check", handleUpdateCheck)
	mux.HandleFunc("/api/update/install", handleUpdateInstall)
	mux.HandleFunc("/api/db", handleDB)
	mux.HandleFunc("/api/files", handleFiles)
	mux.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, libraryIndex()) })
	mux.HandleFunc("/api/library/import", handleLibraryImport)
	mux.HandleFunc("/api/library/clear", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		os.RemoveAll(filepath.Join(dataDir, "library"))
		os.MkdirAll(filepath.Join(dataDir, "library"), 0o755)
		writeJSON(w, libraryIndex())
	})
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, modelIndex()) })
	mux.HandleFunc("/api/models/import", handleModelImport)
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		p := filepath.Join(dataDir, filepath.FromSlash(cleanRel(r.URL.Query().Get("path"))))
		openPath(p)
		w.WriteHeader(204)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func cleanRel(p string) string {
	p = path.Clean("/" + strings.ReplaceAll(p, "\\", "/"))
	return strings.TrimPrefix(p, "/")
}

// ---------- database (one JSON document) ----------

func handleDB(w http.ResponseWriter, r *http.Request) {
	f := filepath.Join(dataDir, "db.json")
	dbMu.Lock()
	defer dbMu.Unlock()
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(f)
		if err != nil {
			b = []byte("null")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case http.MethodPut:
		b, err := io.ReadAll(io.LimitReader(r.Body, 50<<20))
		if err != nil || !json.Valid(b) {
			http.Error(w, "invalid json", 400)
			return
		}
		// keep one rolling backup
		if old, err := os.ReadFile(f); err == nil {
			os.WriteFile(f+".bak", old, 0o644)
		}
		tmp := f + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		os.Rename(tmp, f)
		w.WriteHeader(204)
	default:
		http.Error(w, "method", 405)
	}
}

// ---------- job files (photos, concepts, models) ----------

var safeName = regexp.MustCompile(`[^\w\-. ()]+`)

func handleFiles(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	switch r.Method {
	case http.MethodPost:
		job := safeName.ReplaceAllString(q.Get("job"), "")
		kind := safeName.ReplaceAllString(q.Get("kind"), "")
		if job == "" || kind == "" {
			http.Error(w, "job and kind required", 400)
			return
		}
		dir := filepath.Join(dataDir, "jobs", job, kind)
		os.MkdirAll(dir, 0o755)
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var out []map[string]string
		for _, fh := range r.MultipartForm.File["file"] {
			name := safeName.ReplaceAllString(filepath.Base(fh.Filename), "_")
			if name == "" {
				name = "file"
			}
			dst := uniquePath(filepath.Join(dir, name))
			src, err := fh.Open()
			if err != nil {
				continue
			}
			o, err := os.Create(dst)
			if err == nil {
				io.Copy(o, src)
				o.Close()
			}
			src.Close()
			rel := filepath.ToSlash(filepath.Join("jobs", job, kind, filepath.Base(dst)))
			out = append(out, map[string]string{"name": filepath.Base(dst), "path": rel, "url": "/data/" + rel})
		}
		writeJSON(w, out)
	case http.MethodDelete:
		rel := cleanRel(q.Get("path"))
		if !strings.HasPrefix(rel, "jobs/") {
			http.Error(w, "only job files", 400)
			return
		}
		os.Remove(filepath.Join(dataDir, filepath.FromSlash(rel)))
		w.WriteHeader(204)
	default:
		http.Error(w, "method", 405)
	}
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(c); err != nil {
			return c
		}
	}
}

// ---------- zip helpers ----------

func download(url, dst string) error {
	testLocal := (os.Getenv("TINYTWIN_UPDATE_API") != "" || os.Getenv("TINYTWIN_UPDATE_RAW") != "") && strings.HasPrefix(url, "http://127.0.0.1:")
	if !strings.HasPrefix(url, "https://") && !testLocal {
		return errors.New("only https links are allowed")
	}
	c := &http.Client{Timeout: 20 * time.Minute}
	resp, err := c.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, resp.Body)
	f.Close()
	return err
}

// incomingZip saves either an uploaded zip (multipart "file") or a downloaded one (?url=) to a temp file.
func incomingZip(r *http.Request) (string, error) {
	tmp, err := os.CreateTemp(dataDir, "import-*.zip")
	if err != nil {
		return "", err
	}
	tmp.Close()
	if u := r.URL.Query().Get("url"); u != "" {
		return tmp.Name(), download(u, tmp.Name())
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return tmp.Name(), err
	}
	for {
		p, err := mr.NextPart()
		if err != nil {
			return tmp.Name(), errors.New("no file uploaded")
		}
		if p.FormName() == "file" {
			o, _ := os.Create(tmp.Name())
			_, err = io.Copy(o, p)
			o.Close()
			return tmp.Name(), err
		}
	}
}

func extractZip(zipPath, destDir string, keep func(name string) (string, bool)) (int, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return 0, fmt.Errorf("not a valid zip: %w", err)
	}
	defer zr.Close()
	n := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		name := cleanRel(f.Name)
		if strings.HasPrefix(name, "__MACOSX/") || strings.HasPrefix(path.Base(name), "._") {
			continue
		}
		rel, ok := keep(name)
		if !ok {
			continue
		}
		dst := filepath.Join(destDir, filepath.FromSlash(cleanRel(rel)))
		if !strings.HasPrefix(dst, filepath.Clean(destDir)+string(os.PathSeparator)) {
			continue
		}
		os.MkdirAll(filepath.Dir(dst), 0o755)
		rc, err := f.Open()
		if err != nil {
			continue
		}
		o, err := os.Create(dst)
		if err == nil {
			io.Copy(o, rc)
			o.Close()
			n++
		}
		rc.Close()
	}
	return n, nil
}

func isImage(n string) bool {
	switch strings.ToLower(path.Ext(n)) {
	case ".jpg", ".jpeg", ".png", ".webp":
		return true
	}
	return false
}

// ---------- feature library ----------

func handleLibraryImport(w http.ResponseWriter, r *http.Request) {
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
	lib := filepath.Join(dataDir, "library")
	n, err := extractZip(zp, lib, func(name string) (string, bool) {
		if !isImage(name) && !strings.HasSuffix(strings.ToLower(name), ".txt") {
			return "", false
		}
		// Strip any wrapper folder so paths start at parts/ or sheets/.
		segs := strings.Split(name, "/")
		for i, s := range segs {
			ls := strings.ToLower(s)
			if (ls == "parts" || ls == "sheets") && i < len(segs)-1 {
				return strings.ToLower(s) + "/" + strings.Join(segs[i+1:], "/"), true
			}
		}
		if len(segs) > 1 && isImage(name) {
			return "parts/" + strings.Join(segs[1:], "/"), len(segs) > 2 // wrapper/category/file
		}
		return "", false
	})
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if n == 0 {
		http.Error(w, "No images found in that zip.", 400)
		return
	}
	makeThumbs(lib)
	writeJSON(w, libraryIndex())
}

type Part struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	CatLabel string `json:"catLabel"`
	Section  string `json:"section"`
	Name     string `json:"name"`
	Default  bool   `json:"default"`
	URL      string `json:"url"`
	Thumb    string `json:"thumb"`
	Order    string `json:"order"`
}

var lead = regexp.MustCompile(`^\s*\d+[\s._-]*`)

func label(s string) string {
	s = lead.ReplaceAllString(s, "")
	s = strings.ReplaceAll(strings.ReplaceAll(s, "-", " "), "_", " ")
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func libraryIndex() map[string]any {
	lib := filepath.Join(dataDir, "library")
	parts := []Part{}
	sheets := []map[string]string{}
	filepath.WalkDir(lib, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !isImage(p) {
			return nil
		}
		rel, _ := filepath.Rel(lib, p)
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, ".thumbs/") {
			return nil
		}
		url := "/data/library/" + rel
		thumb := "/data/library/.thumbs/" + strings.TrimSuffix(rel, path.Ext(rel)) + ".jpg"
		if _, err := os.Stat(filepath.Join(lib, ".thumbs", filepath.FromSlash(strings.TrimSuffix(rel, path.Ext(rel))+".jpg"))); err != nil {
			thumb = url
		}
		segs := strings.Split(rel, "/")
		if segs[0] == "sheets" {
			sheets = append(sheets, map[string]string{"name": label(strings.TrimSuffix(path.Base(rel), path.Ext(rel))), "url": url, "thumb": thumb, "order": rel})
			return nil
		}
		if segs[0] != "parts" || len(segs) < 3 {
			return nil
		}
		cat := segs[1]
		section := "Options"
		if len(segs) >= 4 {
			section = label(strings.Join(segs[2:len(segs)-1], " / "))
		}
		base := strings.TrimSuffix(segs[len(segs)-1], path.Ext(rel))
		def := strings.Contains(strings.ToLower(base), "(default)")
		name := strings.TrimSpace(regexp.MustCompile(`(?i)\(default\)`).ReplaceAllString(base, ""))
		parts = append(parts, Part{ID: rel, Category: cat, CatLabel: label(cat), Section: section, Name: label(name), Default: def, URL: url, Thumb: thumb, Order: rel})
		return nil
	})
	sort.Slice(parts, func(i, j int) bool { return natLess(parts[i].Order, parts[j].Order) })
	sort.Slice(sheets, func(i, j int) bool { return natLess(sheets[i]["order"], sheets[j]["order"]) })
	return map[string]any{"parts": parts, "sheets": sheets}
}

var digits = regexp.MustCompile(`\d+`)

func natLess(a, b string) bool {
	pad := func(s string) string {
		return digits.ReplaceAllStringFunc(strings.ToLower(s), func(d string) string { return fmt.Sprintf("%08s", d) })
	}
	return pad(a) < pad(b)
}

// makeThumbs writes 360px JPEG previews so the UI stays fast with 2000px source images.
func makeThumbs(lib string) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	filepath.WalkDir(lib, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !isImage(p) || strings.Contains(filepath.ToSlash(p), "/.thumbs/") {
			return nil
		}
		rel, _ := filepath.Rel(lib, p)
		dst := filepath.Join(lib, ".thumbs", strings.TrimSuffix(rel, filepath.Ext(rel))+".jpg")
		if _, err := os.Stat(dst); err == nil {
			return nil
		}
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			thumb(p, dst, 360)
		}()
		return nil
	})
	wg.Wait()
}

func thumb(src, dst string, max int) {
	f, err := os.Open(src)
	if err != nil {
		return
	}
	img, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	scale := float64(max) / float64(w)
	if h > w {
		scale = float64(max) / float64(h)
	}
	if scale >= 1 {
		scale = 1
	}
	nw, nh := int(float64(w)*scale+0.5), int(float64(h)*scale+0.5)
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}
	out := image.NewRGBA(image.Rect(0, 0, nw, nh))
	// box filter
	for y := 0; y < nh; y++ {
		y0 := b.Min.Y + int(float64(y)/scale)
		y1 := b.Min.Y + int(float64(y+1)/scale)
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < nw; x++ {
			x0 := b.Min.X + int(float64(x)/scale)
			x1 := b.Min.X + int(float64(x+1)/scale)
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var r, g, bb, a, n uint64
			step := 1
			if (x1-x0)*(y1-y0) > 64 {
				step = 2
			}
			for yy := y0; yy < y1 && yy < b.Max.Y; yy += step {
				for xx := x0; xx < x1 && xx < b.Max.X; xx += step {
					cr, cg, cb, ca := img.At(xx, yy).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bb += uint64(cb)
					a += uint64(ca)
					n++
				}
			}
			if n == 0 {
				n = 1
			}
			out.Set(x, y, color.RGBA64{uint16(r / n), uint16(g / n), uint16(bb / n), uint16(a / n)})
		}
	}
	os.MkdirAll(filepath.Dir(dst), 0o755)
	o, err := os.Create(dst)
	if err != nil {
		return
	}
	// flatten alpha onto white for JPEG
	flat := image.NewRGBA(out.Bounds())
	for i := 0; i < len(out.Pix); i += 4 {
		inv := 255 - out.Pix[i+3] // RGBA is premultiplied, so this can't overflow
		for c := 0; c < 3; c++ {
			flat.Pix[i+c] = out.Pix[i+c] + inv
		}
		flat.Pix[i+3] = 255
	}
	jpeg.Encode(o, flat, &jpeg.Options{Quality: 84})
	o.Close()
}

// ---------- 3D models ----------

var modelExt = map[string]bool{".glb": true, ".gltf": true, ".obj": true, ".mtl": true, ".stl": true, ".png": true, ".jpg": true, ".jpeg": true, ".bin": true}

func handleModelImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", 405)
		return
	}
	name := safeName.ReplaceAllString(r.URL.Query().Get("name"), "")
	if name == "" {
		name = "model-" + time.Now().Format("20060102-150405")
	}
	dest := filepath.Join(dataDir, "models", name)
	zp, err := incomingZip(r)
	defer os.Remove(zp)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	n, err := extractZip(zp, dest, func(n string) (string, bool) {
		return n, modelExt[strings.ToLower(path.Ext(n))]
	})
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if n == 0 {
		http.Error(w, "No GLB, OBJ or STL files found in that zip.", 400)
		return
	}
	writeJSON(w, modelIndex())
}

func modelIndex() []map[string]any {
	out := []map[string]any{}
	for _, root := range []string{"kit", "models", "jobs"} {
		base := filepath.Join(dataDir, root)
		filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(p))
			if ext != ".glb" && ext != ".gltf" && ext != ".obj" && ext != ".stl" {
				return nil
			}
			rel, _ := filepath.Rel(dataDir, p)
			rel = filepath.ToSlash(rel)
			st, _ := d.Info()
			segs := strings.Split(rel, "/")
			group := strings.Join(segs[:min(2, len(segs)-1)], "/")
			if segs[0] == "kit" {
				group = "kit"
			}
			out = append(out, map[string]any{"name": filepath.Base(p), "path": rel, "url": "/data/" + rel, "group": group, "size": st.Size(), "ext": ext[1:], "modified": st.ModTime().Format(time.RFC3339)})
			return nil
		})
	}
	return out
}

func init() {
	mime.AddExtensionType(".glb", "model/gltf-binary")
	mime.AddExtensionType(".gltf", "model/gltf+json")
	mime.AddExtensionType(".stl", "model/stl")
	mime.AddExtensionType(".obj", "text/plain")
	mime.AddExtensionType(".mtl", "text/plain")
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".css", "text/css")
}
