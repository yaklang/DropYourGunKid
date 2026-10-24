package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProtocolResponse(t *testing.T) {
	if responseFor("session", "nonce") != "e624327987ab78b2499c0e7a03b51465d4d395dac05c93c2b7785812fde36558" {
		t.Fatal("protocol formula changed")
	}
}

func TestCompleteBindsSessionAndResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.URL.Query().Get("s") != "session" || r.PostForm.Get("challenge") != "nonce" || r.PostForm.Get("response") != responseFor("session", "nonce") {
			t.Error("unbound request")
		}
		w.Write([]byte("synthetic"))
	}))
	defer server.Close()
	body, err := complete(server.Client(), server.URL, "session", "nonce")
	if err != nil || body != "synthetic" {
		t.Fatalf("%s %v", body, err)
	}
}
