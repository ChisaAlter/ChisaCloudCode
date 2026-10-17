package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPiAttachmentsStorePrivateBytesAndPassImagesToRPC(t *testing.T) {
	isolatePi(t)
	png := "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDlgAAAAASUVORK5CYII="
	files, err := piStoreAttachments("attachment-qa", []piAttachmentInput{
		{Name: "../../说明.txt", MimeType: "text/plain", DataBase64: base64.StdEncoding.EncodeToString([]byte("仅供本轮参考"))},
		{Name: "截图.png", MimeType: "image/png", DataBase64: png},
		{Name: "截图.png", MimeType: "image/png", DataBase64: png},
	})
	if err != nil || len(files) != 3 {
		t.Fatalf("cannot store selected files: %v", err)
	}
	if files[1].Path == files[2].Path {
		t.Fatal("same-name attachments overwrote each other")
	}
	for _, file := range files {
		rel, err := filepath.Rel(filepath.Join(piSessionDirectory("attachment-qa"), "attachments"), file.Path)
		if err != nil || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") {
			t.Fatal("file display name escaped private attachment storage")
		}
		data, err := os.ReadFile(file.Path)
		if err != nil || len(data) != file.Size {
			t.Fatal("selected file bytes were lost")
		}
	}
	text, _ := os.ReadFile(files[0].Path)
	if string(text) != "仅供本轮参考" {
		t.Fatal("Unicode file contents changed")
	}
	fields, err := piPromptFields("解释附件", "Claude reference", files)
	if err != nil || !strings.Contains(fields["message"].(string), strings.ReplaceAll(files[0].Path, `\`, `\\`)) || !strings.Contains(fields["message"].(string), "说明.txt") || !strings.Contains(fields["message"].(string), "仅供本轮参考") {
		t.Fatal("Pi did not receive attachment reference metadata")
	}
	images := fields["images"].([]map[string]any)
	if len(images) != 2 || images[0]["type"] != "image" || images[0]["mimeType"] != "image/png" || images[0]["data"] != png {
		t.Fatal("Pi image RPC payload lost image bytes or MIME type")
	}
	public := piSanitizeValue(&piSession{}, map[string]any{"content": []any{images[0]}}).(map[string]any)
	if public["content"].([]any)[0].(map[string]any)["data"] != "[image attachment]" {
		t.Fatal("live frontend events duplicated raw image bytes")
	}
}

func TestPiAttachmentsRejectInvalidBatchBeforeWriting(t *testing.T) {
	isolatePi(t)
	cases := [][]piAttachmentInput{
		{{Name: "坏文件.txt", DataBase64: "not base64"}},
		{{Name: "", DataBase64: ""}},
		{{Name: "过大.bin", DataBase64: strings.Repeat("A", base64.StdEncoding.EncodedLen(piMaxAttachmentSize)+4)}},
		make([]piAttachmentInput, 11),
		{{Name: "valid.txt", DataBase64: "YQ=="}, {Name: "invalid.txt", DataBase64: "?"}},
	}
	for _, inputs := range cases {
		if _, err := piStoreAttachments("invalid-qa", inputs); err == nil {
			t.Fatal("invalid attachment batch was accepted")
		}
		if _, err := os.Stat(filepath.Join(piSessionDirectory("invalid-qa"), "attachments")); !os.IsNotExist(err) {
			t.Fatal("invalid batch left partially written attachments")
		}
	}
}
