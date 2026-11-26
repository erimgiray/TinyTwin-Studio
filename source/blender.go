package main

// Blender bridge: finds the Blender install, converts .blend files to GLB + a scene report
// (blender/export_blend.py run in background mode, cached by file hash), and opens files in Blender.

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed blender/export_blend.py
var exportBlendPy []byte

// Bump when export_blend.py changes so cached conversions are redone.
const blendExportVersion = "1"

var (
	blendMu    sync.Mutex
	blendLocks = map[string]*sync.Mutex{}
)

type blenderConf struct {
	Path string `json:"path"`
}

func blenderConfPath() string { return filepath.Join(dataDir, "blender.json") }

func readBlenderConf() blenderConf {
	var c blenderConf
	if b, err := os.ReadFile(blenderConfPath()); err == nil {
		json.Unmarshal(b, &c)
	}
	return c
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// findBlender returns the Blender executable: the one chosen in Settings, else the newest install found.
func findBlender() (string, bool) {
	if c := readBlenderConf(); c.Path != "" && isFile(c.Path) {
		return c.Path, true
	}
	if p := os.Getenv("TINYTWIN_BLENDER"); p != "" && isFile(p) {
		return p, true
	}
	var found []string
	if runtime.GOOS == "windows" {
		for _, pf := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if pf == "" {
				continue
			}
			m, _ := filepath.Glob(filepath.Join(pf, "Blender Foundation", "Blender*", "blender.exe"))
			found = append(found, m...)
			if p := filepath.Join(pf, `Steam\steamapps\common\Blender\blender.exe`); isFile(p) {
				found = append(found, p)
			}
		}
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			m, _ := filepath.Glob(filepath.Join(la, "Programs", "Blender Foundation", "Blender*", "blender.exe"))
			found = append(found, m...)
		}
	} else if runtime.GOOS == "darwin" {
		if p := "/Applications/Blender.app/Contents/MacOS/Blender"; isFile(p) {
			found = append(found, p)
		}
	}
	if len(found) > 0 {
		sort.Slice(found, func(i, j int) bool { return natLess(found[j], found[i]) }) // newest version first
		return found[0], true
	}
	if p, err := exec.LookPath("blender"); err == nil {
		return p, true
	}
	return "", false
}

func blenderRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/blender", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
		case http.MethodPut:
			var c blenderConf
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&c); err != nil {
				http.Error(w, "invalid json", 400)
				return
			}
			c.Path = strings.Trim(strings.TrimSpace(c.Path), `"`)
			if c.Path != "" && !isFile(c.Path) {
				http.Error(w, "No file at "+c.Path, 400)
				return
			}
			b, _ := json.Marshal(c)
			os.WriteFile(blenderConfPath(), b, 0o644)
		default:
			http.Error(w, "method", 405)
			return
		}
		p, ok := findBlender()
		writeJSON(w, map[string]any{"path": p, "found": ok, "chosen": readBlenderConf().Path})
	})
	mux.HandleFunc("/api/blend/convert", handleBlendConvert)
	mux.HandleFunc("/api/blend/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST", 405)
			return
		}
		src, err := dataFile(r.URL.Query().Get("path"), ".blend")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		bl, ok := findBlender()
		if !ok {
			http.Error(w, "Blender isn't installed (or wasn't found). Set its location in Settings.", 400)
			return
		}
		if err := exec.Command(bl, src).Start(); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
}

// dataFile resolves a data-folder-relative path to an existing file with the given extension.
func dataFile(rel, ext string) (string, error) {
	rel = cleanRel(rel)
	if rel == "" || !strings.EqualFold(filepath.Ext(rel), ext) {
		return "", fmt.Errorf("expected a %s file", ext)
	}
	p := filepath.Join(dataDir, filepath.FromSlash(rel))
	if !isFile(p) {
		return "", errors.New("file not found: " + rel)
	}
	return p, nil
}

// handleBlendConvert: POST ?path=<data-relative .blend> or a multipart "file" upload
// (saved under models/<name>/ so it shows in the model list). Returns the scene report plus glb URL.
func handleBlendConvert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", 405)
		return
	}
	var src, rel string
	if q := r.URL.Query().Get("path"); q != "" {
		p, err := dataFile(q, ".blend")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		src, rel = p, cleanRel(q)
	} else {
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		fhs := r.MultipartForm.File["file"]
		if len(fhs) == 0 {
			http.Error(w, "no file uploaded", 400)
			return
		}
		name := safeName.ReplaceAllString(filepath.Base(fhs[0].Filename), "_")
		if !strings.EqualFold(filepath.Ext(name), ".blend") {
			http.Error(w, "Pick a .blend file", 400)
			return
		}
		dir := filepath.Join(dataDir, "models", strings.TrimSuffix(name, filepath.Ext(name)))
		os.MkdirAll(dir, 0o755)
		src = filepath.Join(dir, name)
		in, err := fhs[0].Open()
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		o, err := os.Create(src)
		if err == nil {
			_, err = io.Copy(o, in)
			o.Close()
		}
		in.Close()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		rel, _ = filepath.Rel(dataDir, src)
		rel = filepath.ToSlash(rel)
	}
	out, err := convertBlend(src, r.URL.Query().Get("force") == "1")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var report map[string]any
	b, _ := os.ReadFile(filepath.Join(out, "scene.json"))
	json.Unmarshal(b, &report)
	if report == nil {
		report = map[string]any{}
	}
	key := filepath.Base(out)
	report["glb"] = "/data/blend-cache/" + key + "/scene.glb"
	report["path"] = rel
	report["name"] = filepath.Base(src)
	writeJSON(w, report)
}

func convertBlend(src string, force bool) (string, error) {
	bl, ok := findBlender()
	if !ok {
		return "", errors.New("Blender isn't installed (or wasn't found). Install Blender, or set its location in Settings → Blender.")
	}
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	io.WriteString(h, blendExportVersion+"\x00")
	io.Copy(h, f)
	f.Close()
	key := hex.EncodeToString(h.Sum(nil))[:24]
	out := filepath.Join(dataDir, "blend-cache", key)

	blendMu.Lock()
	lk := blendLocks[key]
	if lk == nil {
		lk = &sync.Mutex{}
		blendLocks[key] = lk
	}
	blendMu.Unlock()
	lk.Lock()
	defer lk.Unlock()

	if !force && isFile(filepath.Join(out, "scene.glb")) && isFile(filepath.Join(out, "scene.json")) {
		return out, nil
	}
	os.RemoveAll(out)
	os.MkdirAll(out, 0o755)
	script := filepath.Join(dataDir, "blend-cache", "export_blend.py")
	if err := os.WriteFile(script, exportBlendPy, 0o644); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	// Flags must come before the file: Blender handles arguments in order. --disable-autoexec stops
	// scripts embedded in the .blend from running.
	cmd := exec.CommandContext(ctx, bl, "-b", "--factory-startup", "--disable-autoexec", src, "--python", script, "--", out)
	hideConsole(cmd)
	logOut, err := cmd.CombinedOutput()
	logTail := string(logOut)
	if len(logTail) > 4000 {
		logTail = logTail[len(logTail)-4000:]
	}
	os.WriteFile(filepath.Join(out, "blender.log"), logOut, 0o644)
	if ctx.Err() != nil {
		return "", errors.New("Blender took more than 5 minutes on this file and was stopped")
	}
	var rep struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	b, rerr := os.ReadFile(filepath.Join(out, "scene.json"))
	if rerr == nil {
		json.Unmarshal(b, &rep)
	}
	if rerr != nil || !rep.OK || !isFile(filepath.Join(out, "scene.glb")) {
		log.Println("blend convert failed:", err, logTail)
		msg := rep.Error
		if msg == "" {
			msg = logTail
		}
		os.RemoveAll(out)
		return "", errors.New("Blender couldn't export this file:\n" + strings.TrimSpace(msg))
	}
	return out, nil
}
