// gateway-client 是 DYGK 靶场的透明无害客户端。
// 协议和源码公开；它只访问调用者指定的同源靶场，并在成功后写入隔离标记。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

const protocol = "dygk-client-v1"

func responseFor(run, challenge string) string {
	sum := sha256.Sum256([]byte(run + ":" + challenge + ":" + protocol))
	return hex.EncodeToString(sum[:])
}

func get(client *http.Client, endpoint string) (string, error) {
	response, err := client.Get(endpoint)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s returned %s: %s", endpoint, response.Status, strings.TrimSpace(string(body)))
	}
	return strings.TrimSpace(string(body)), nil
}

func complete(client *http.Client, endpoint, run, challenge string) (string, error) {
	values := url.Values{
		"session":   {run},
		"challenge": {challenge},
		"response":  {responseFor(run, challenge)},
	}
	response, err := client.PostForm(endpoint+"?s="+url.QueryEscape(run), values)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16*1024))
	if err != nil {
		return "", err
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("POST %s returned %s: %s", endpoint, response.Status, strings.TrimSpace(string(body)))
	}
	return strings.TrimSpace(string(body)), nil
}

func main() {
	baseURL := flag.String("base-url", "", "同源靶场地址，含 DYGK prefix")
	run := flag.String("session", "", "本轮十六进制会话")
	marker := flag.String("marker", "", "下载水印 DYGK-DL-<nonce>")
	showVersion := flag.Bool("version", false, "显示协议版本")
	dryRun := flag.Bool("dry-run", false, "只显示将访问的端点，不发请求或写文件")
	flag.Parse()
	if *showVersion {
		fmt.Println(protocol)
		return
	}
	parsed, err := url.Parse(*baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		fmt.Fprintln(os.Stderr, "base-url 必须是无凭据、查询或片段的 HTTP(S) 地址，路径为 DYGK prefix")
		os.Exit(2)
	}
	expectedMarker := "/tmp/dygk-client-" + *run
	if !regexp.MustCompile(`^[a-f0-9]{48}$`).MatchString(*run) || !regexp.MustCompile(`^DYGK-DL-[a-f0-9]{48}$`).MatchString(*marker) {
		fmt.Fprintln(os.Stderr, "session 和 marker 必须使用本轮的 48 位十六进制标识")
		os.Exit(2)
	}
	challengeURL := strings.TrimRight(*baseURL, "/") + "/client/challenge?s=" + url.QueryEscape(*run)
	completeURL := strings.TrimRight(*baseURL, "/") + "/client/complete"
	if *dryRun {
		fmt.Printf("GET %s\nPOST %s\nmarker %s\n", challengeURL, completeURL, expectedMarker)
		return
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	challenge, err := get(client, challengeURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	capabilities, err := complete(client, completeURL, *run, challenge)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(expectedMarker, []byte(*marker), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(capabilities)
}
