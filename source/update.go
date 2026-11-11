package main

// Self-updater: checks GitHub Releases, downloads the new exe, verifies it,
// swaps it in place of the running exe and relaunches.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "1.3.1" // overridden at build time: -ldflags "-X main.version=..."

const defaultUpdateRepo = "erimgiray/TinyTwin-Studio"

func assetName() string {
	if runtime.GOOS == "windows" {
		return "TinyTwinStudio.exe"
	}
	return "TinyTwinStudio-" + runtime.GOOS
}

type releaseInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Newer     bool   `json:"newer"`
	Notes     string `json:"notes"`
	Published string `json:"published"`
	Size      int64  `json:"size"`
	Repo      string `json:"repo"`
	Page      string `json:"page"`
	Error     string `json:"error,omitempty"`
	assetURL  string
	sumURL    string
	sum       string
}

var updMu sync.Mutex

func updateAPI() string {
	if u := os.Getenv("TINYTWIN_UPDATE_API"); u != "" { // for testing
		return strings.TrimRight(u, "/")
	}
	return "https://api.github.com"
}

func validRepo(r string) bool {
	parts := strings.Split(r, "/")
	if len(parts) != 2 {
		return false
	}
	for _, p := range parts {
		if p == "" || safeName.MatchString(p) || strings.Contains(p, "..") {
			return false
		}
	}
	return true
}

func checkGitHubRelease(repo string) releaseInfo {
	ri := releaseInfo{Current: version, Repo: repo}
	if !validRepo(repo) {
		ri.Error = "The update source should look like owner/repository."
		return ri
	}
	req, _ := http.NewRequest("GET", updateAPI()+"/repos/"+repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "TinyTwinStudio/"+version)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		ri.Error = "Couldn't reach GitHub: " + err.Error()
		return ri
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		ri.Error = "No published release found at github.com/" + repo + " (the repository must be public and have a release)."
		return ri
	}
	if resp.StatusCode != 200 {
		ri.Error = fmt.Sprintf("GitHub answered HTTP %d", resp.StatusCode)
		return ri
	}
	var rel struct {
		Tag       string `json:"tag_name"`
		Body      string `json:"body"`
		Published string `json:"published_at"`
		HTMLURL   string `json:"html_url"`
		Assets    []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		ri.Error = "Couldn't read the release information."
		return ri
	}
	ri.Latest = strings.TrimPrefix(rel.Tag, "v")
	ri.Notes, ri.Published, ri.Page = rel.Body, rel.Published, rel.HTMLURL
	for _, a := range rel.Assets {
		switch strings.ToLower(a.Name) {
		case strings.ToLower(assetName()):
			ri.assetURL, ri.Size = a.URL, a.Size
		case strings.ToLower(assetName()) + ".sha256":
			ri.sumURL = a.URL
		}
	}
	ri.Newer = newerThan(ri.Latest, version)
	if ri.Newer && ri.assetURL == "" {
		ri.Error = "Release " + rel.Tag + " has no " + assetName() + " file attached."
		ri.Newer = false
	}
	return ri
}

func rawBase() string {
	if u := os.Getenv("TINYTWIN_UPDATE_RAW"); u != "" { // for testing
		return strings.TrimRight(u, "/")
	}
	return "https://raw.githubusercontent.com"
}

// checkManifest reads latest.json from the repository's default branch:
// {"version","notes","published","exe":{"url","sha256","size"}}
func checkManifest(repo string) releaseInfo {
	ri := releaseInfo{Current: version, Repo: repo, Page: "https://github.com/" + repo}
	req, _ := http.NewRequest("GET", rawBase()+"/"+repo+"/HEAD/latest.json?t="+strconv.FormatInt(time.Now().Unix(), 10), nil)
	req.Header.Set("User-Agent", "TinyTwinStudio/"+version)
	req.Header.Set("Cache-Control", "no-cache")
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		ri.Error = "Couldn't reach GitHub: " + err.Error()
		return ri
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		ri.Error = fmt.Sprintf("No update information found at github.com/%s (HTTP %d).", repo, resp.StatusCode)
		return ri
	}
	var m struct {
		Version   string `json:"version"`
		Notes     string `json:"notes"`
		Published string `json:"published"`
		Exe       struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Size   int64  `json:"size"`
		} `json:"exe"`
		Linux struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Size   int64  `json:"size"`
		} `json:"linux"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m); err != nil || m.Version == "" {
		ri.Error = "The update information file is malformed."
		return ri
	}
	ri.Latest, ri.Notes, ri.Published = strings.TrimPrefix(m.Version, "v"), m.Notes, m.Published
	a := m.Exe
	if runtime.GOOS != "windows" {
		a = m.Linux
	}
	ri.assetURL, ri.sum, ri.Size = a.URL, a.SHA256, a.Size
	ri.Newer = newerThan(ri.Latest, version)
	if ri.Newer && (ri.assetURL == "" || len(ri.sum) != 64) {
		ri.Error = "Version " + ri.Latest + " is listed but its download or checksum is missing."
		ri.Newer = false
	}
	return ri
}

// checkRelease asks both sources (latest.json and GitHub Releases) and keeps the best answer.
func checkRelease(repo string) releaseInfo {
	if !validRepo(repo) {
		return releaseInfo{Current: version, Repo: repo, Error: "The update source should look like owner/repository."}
	}
	var a, b releaseInfo
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a = checkManifest(repo) }()
	go func() { defer wg.Done(); b = checkGitHubRelease(repo) }()
	wg.Wait()
	switch {
	case a.Newer && b.Newer:
		if newerThan(b.Latest, a.Latest) {
			return b
		}
		return a
	case a.Newer:
		return a
	case b.Newer:
		return b
	case a.Error == "":
		return a
	case b.Error == "":
		return b
	}
	return a
}

func newerThan(a, b string) bool {
	pa, pb := splitVer(a), splitVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func splitVer(v string) [3]int {
	var out [3]int
	for i, p := range strings.SplitN(strings.TrimPrefix(v, "v"), ".", 3) {
		n, _ := strconv.Atoi(strings.TrimFunc(p, func(r rune) bool { return r < '0' || r > '9' }))
		out[i] = n
	}
	return out
}

func handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	repo := r.URL.Query().Get("repo")
	if repo == "" {
		repo = defaultUpdateRepo
	}
	writeJSON(w, checkRelease(repo))
}

func handleUpdateInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST", 405)
		return
	}
	if !updMu.TryLock() {
		http.Error(w, "An update is already being installed.", 409)
		return
	}
	defer updMu.Unlock()
	repo := r.URL.Query().Get("repo")
	if repo == "" {
		repo = defaultUpdateRepo
	}
	ri := checkRelease(repo)
	if ri.Error != "" {
		http.Error(w, ri.Error, 400)
		return
	}
	if !ri.Newer {
		http.Error(w, "You already have the latest version ("+version+").", 400)
		return
	}
	newExe, err := installUpdate(ri)
	if err != nil {
		log.Println("update failed:", err)
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]string{"installed": ri.Latest})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(700 * time.Millisecond)
		cmd := exec.Command(newExe, "--updated")
		cmd.Dir = filepath.Dir(newExe)
		cmd.Env = os.Environ()
		if err := cmd.Start(); err != nil {
			log.Println("relaunch failed:", err)
		}
		os.Exit(0)
	}()
}

// installUpdate downloads + verifies the new build and swaps it with the running exe.
// The running exe is renamed to <name>.old (Windows allows renaming a running exe).
func installUpdate(ri releaseInfo) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)
	tmp := exe + ".download"
	os.Remove(tmp)
	if err := download(ri.assetURL, tmp); err != nil {
		os.Remove(tmp)
		if errors.Is(err, os.ErrPermission) {
			return "", errors.New("The app's folder isn't writable. Move TinyTwinStudio.exe to a folder like Desktop or Documents and try again.")
		}
		return "", fmt.Errorf("download failed: %w", err)
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() < 1<<20 || (ri.Size > 0 && st.Size() != ri.Size) {
		os.Remove(tmp)
		return "", errors.New("the downloaded file is incomplete — please try again")
	}
	if err := checkHeader(tmp); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if ri.sum != "" || ri.sumURL != "" {
		want, err := ri.sum, error(nil)
		if want == "" {
			want, err = fetchSum(ri.sumURL)
		}
		if err != nil {
			os.Remove(tmp)
			return "", err
		}
		got, _ := fileSHA256(tmp)
		if !strings.EqualFold(want, got) {
			os.Remove(tmp)
			return "", errors.New("the downloaded file failed its checksum — not installed")
		}
	}
	os.Chmod(tmp, 0o755)
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("couldn't replace the app file (%v). Is it in a protected folder?", err)
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe) // roll back
		return "", fmt.Errorf("couldn't put the new version in place: %v", err)
	}
	log.Printf("updated %s -> %s in %s", version, ri.Latest, dir)
	return exe, nil
}

func checkHeader(p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	b := make([]byte, 4)
	io.ReadFull(f, b)
	ok := false
	switch runtime.GOOS {
	case "windows":
		ok = b[0] == 'M' && b[1] == 'Z'
	case "linux":
		ok = string(b) == "\x7fELF"
	default:
		ok = true
	}
	if !ok {
		return errors.New("the downloaded file isn't a valid program — not installed")
	}
	return nil
}

func fetchSum(url string) (string, error) {
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Get(url)
	if err != nil {
		return "", fmt.Errorf("couldn't fetch checksum: %w", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	f := strings.Fields(string(b))
	if resp.StatusCode != 200 || len(f) == 0 || len(f[0]) != 64 {
		return "", errors.New("checksum file is missing or malformed — not installed")
	}
	return f[0], nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), nil
}

// afterUpdate runs at startup: if we were just relaunched by the updater, wait for the
// old process to free the port, and tidy the previous exe once it has exited.
func afterUpdate(addr string) net.Listener {
	updated := false
	for _, a := range os.Args[1:] {
		if a == "--updated" {
			updated = true
		}
	}
	if exe, err := os.Executable(); err == nil {
		go func() {
			for i := 0; i < 30; i++ {
				if err := os.Remove(exe + ".old"); err == nil || os.IsNotExist(err) {
					return
				}
				time.Sleep(2 * time.Second)
			}
		}()
	}
	if !updated {
		return nil
	}
	for i := 0; i < 60; i++ {
		if ln, err := net.Listen("tcp", addr); err == nil {
			return ln
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil
}
