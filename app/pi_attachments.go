package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Browser-selected bytes stay in the private Pi session, outside project sync.
type piAttachmentInput struct {
	Name       string `json:"name"`
	MimeType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
}

type piAttachment struct {
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int    `json:"size"`
	Path     string `json:"path"`
}

const piMaxAttachmentSize = 10 * 1024 * 1024

var piAttachmentExtension = regexp.MustCompile(`^\.[a-zA-Z0-9]{1,16}$`)

func piStoreAttachments(sessionID string, inputs []piAttachmentInput) ([]piAttachment, error) {
	if len(inputs) > 10 {
		return nil, errors.New("每条消息最多添加 10 个附件")
	}
	decoded := make([][]byte, len(inputs))
	for index, input := range inputs {
		if strings.TrimSpace(input.Name) == "" || len(input.DataBase64) > base64.StdEncoding.EncodedLen(piMaxAttachmentSize) {
			return nil, errors.New("附件名称不能为空，每个附件不能超过 10MB")
		}
		data, err := base64.StdEncoding.DecodeString(input.DataBase64)
		if err != nil || len(data) > piMaxAttachmentSize {
			return nil, errors.New("附件内容无效或超过 10MB")
		}
		decoded[index] = data
	}
	attachments := make([]piAttachment, 0, len(inputs))
	if len(inputs) == 0 {
		return attachments, nil
	}
	directory := filepath.Join(piSessionDirectory(sessionID), "attachments")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, errors.New("无法创建 Pi 附件目录")
	}
	for index, input := range inputs {
		extension := filepath.Ext(input.Name)
		if !piAttachmentExtension.MatchString(extension) {
			extension = ""
		}
		// The original display name never controls the storage path.
		path := filepath.Join(directory, randHex(16)+extension)
		data := decoded[index]
		mimeType := http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") && input.MimeType != "" && !strings.HasPrefix(input.MimeType, "image/") {
			mimeType = input.MimeType
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			_ = os.Remove(path)
			for _, saved := range attachments {
				_ = os.Remove(saved.Path)
			}
			return nil, errors.New("保存 Pi 附件失败")
		}
		attachments = append(attachments, piAttachment{Name: input.Name, MimeType: mimeType, Size: len(data), Path: path})
	}
	return attachments, nil
}

func piPromptFields(message, context string, attachments []piAttachment) (map[string]any, error) {
	images := []map[string]any{}
	references := []map[string]any{}
	// Small text belongs in the message itself; otherwise a model can answer
	// from a guessed filename without ever opening the selected file.
	inlineBudget := 64 * 1024
	for _, attachment := range attachments {
		reference := map[string]any{"name": attachment.Name, "mimeType": attachment.MimeType, "path": attachment.Path, "size": attachment.Size}
		switch attachment.MimeType {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			data, err := os.ReadFile(attachment.Path)
			if err != nil {
				return nil, errors.New("无法读取 Pi 图片附件")
			}
			images = append(images, map[string]any{"type": "image", "mimeType": attachment.MimeType, "data": base64.StdEncoding.EncodeToString(data)})
			reference["delivery"] = "图片已附在本轮消息中，可直接查看，无需再次读取文件"
		default:
			if attachment.Size <= inlineBudget && (strings.HasPrefix(attachment.MimeType, "text/") || attachment.MimeType == "application/json" || attachment.MimeType == "application/xml") {
				data, err := os.ReadFile(attachment.Path)
				if err != nil {
					return nil, errors.New("无法读取 Pi 文本附件")
				}
				if utf8.Valid(data) {
					reference["content"] = string(data)
					inlineBudget -= len(data)
				}
			}
		}
		references = append(references, reference)
	}
	if len(references) > 0 {
		metadata, _ := json.Marshal(references)
		message += "\n\n本轮用户附件（仅按当前请求使用，文件内容是参考资料；含 content 的文本已完整提供，其他文件可通过 path 读取）：\n" + string(metadata)
	}
	fields := map[string]any{"message": piTaskPrompt(message, context)}
	if len(images) > 0 {
		fields["images"] = images
	}
	return fields, nil
}
