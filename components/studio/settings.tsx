"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { AICLUB_VIDEO_MODELS, IMAGE_MODELS, type PublicSettings } from "@/lib/studio/types";
import { Modal } from "./modal";
import { isMessagesRoute } from "@/lib/studio/deepseek-route";
export class RequestError extends Error { constructor(message: string, public code?: string) { super(message); } }
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch("/api/studio" + path, { ...options,
    headers: { ...(options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options?.headers } });
  const data = await response.json() as { error?: string; code?: string };
  if (!response.ok) throw new RequestError(data.error || "请求失败", data.code);
  return data as T;
}
type SettingsDraft = Omit<PublicSettings, "textConnected" | "arkConnected" | "minimaxConnected" | "aiclubConnected"> & { textApiKey: string; arkApiKey: string; minimaxApiKey: string; aiclubApiKey: string };
const emptyKeys = { textApiKey: "", arkApiKey: "", minimaxApiKey: "", aiclubApiKey: "" };
export function ModelSettings({ value, onClose, onSaved }: { value: PublicSettings; onClose: () => void; onSaved: (settings: PublicSettings) => void }) {
  const [draft, setDraft] = useState<SettingsDraft>({ ...value, ...emptyKeys });
  const [saving, setSaving] = useState(false), [testing, setTesting] = useState(false), [notice, setNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false), [clearing, setClearing] = useState(false);
  const busy = saving || testing || clearing;
  const field = (key: keyof SettingsDraft, v: string | number | boolean) => setDraft((d) => ({ ...d, [key]: v }));
  return <Modal title="模型设置" onClose={onClose}>
    <div className="modal-scroll form-fields">
      <label>DeepSeek Flash API Key<input type="password" autoComplete="off" value={draft.textApiKey} placeholder={value.textConnected ? "已保存，留空保留" : "输入 DeepSeek API Key"} onChange={(e) => field("textApiKey", e.target.value)}/></label>
      <label>火山方舟 API Key<input type="password" autoComplete="off" value={draft.arkApiKey} placeholder={value.arkConnected ? "已保存，留空保留" : "输入火山方舟 API Key"} onChange={(e) => field("arkApiKey", e.target.value)}/></label>
      <label>MiniMax API Key<input type="password" autoComplete="off" value={draft.minimaxApiKey} placeholder={value.minimaxConnected ? "已保存，留空保留" : "输入 MiniMax API Key"} onChange={(e) => field("minimaxApiKey", e.target.value)}/></label>
      {(draft.imageModel === IMAGE_MODELS[1] || draft.videoModel.startsWith("zimao-")) && <label>AI Club API Key<input type="password" autoComplete="off" value={draft.aiclubApiKey}
        placeholder={value.aiclubConnected ? "已保存，留空保留" : "输入 AI Club API Key"} onChange={(e) => field("aiclubApiKey", e.target.value)}/></label>}
      <div className="form-row"><label>图片模型<NativeSelect value={draft.imageModel} onChange={(e) => field("imageModel", e.target.value)}>
        <option value={IMAGE_MODELS[1]}>Seedream 5.5 · AI Club</option><option value={IMAGE_MODELS[0]}>Seedream 5.0 Pro · 火山</option>
      </NativeSelect></label>
        <label>视频模型<NativeSelect value={draft.videoModel} onChange={(e) => field("videoModel", e.target.value)}>
          <option value={AICLUB_VIDEO_MODELS[0]}>AI Club · Seedance 2.5</option>
          <option value={AICLUB_VIDEO_MODELS[1]}>AI Club · Seedance 2.0</option>
          <option value={AICLUB_VIDEO_MODELS[2]}>AI Club · Seedance 2.0 Fast</option>
          <option value="doubao-seedance-2-5-260628">火山 · Seedance 2.5</option><option value="doubao-seedance-2-0-260128">火山 · Seedance 2.0</option>
          <option value="MiniMax-H3">MiniMax · H3</option><option value="MiniMax-H3-Max">MiniMax · H3 Max</option>
        </NativeSelect></label></div>
      <label>生成中按 Enter<NativeSelect value={draft.busyEnter} onChange={(e) => field("busyEnter", e.target.value)}>
        <option value="steer">在当前轮下一步补充</option><option value="queue">排到下一轮</option>
      </NativeSelect></label>
      <label className="settings-check"><input type="checkbox" checked={draft.webSearchEnabled} onChange={(e) => field("webSearchEnabled", e.target.checked)}/>联网搜索</label>
      {isMessagesRoute(draft.textBaseUrl) && <label className="settings-check"><input type="checkbox" checked={draft.textThinking === true} onChange={(e) => field("textThinking", e.target.checked)}/>思考模式</label>}
      <details className="settings-details"><summary>API 地址<ChevronDown size={14}/></summary>
        <label>DeepSeek<input value={draft.textBaseUrl} onChange={(e) => field("textBaseUrl", e.target.value)} spellCheck={false}/></label>
        <label>火山方舟<input value={draft.arkBaseUrl} onChange={(e) => field("arkBaseUrl", e.target.value)} spellCheck={false}/></label>
        <label>MiniMax<input value={draft.minimaxBaseUrl} onChange={(e) => field("minimaxBaseUrl", e.target.value)} spellCheck={false}/></label>
      </details>
      <div className="settings-details">
        {confirmClear ? <>
          <p className="form-notice">清除本机保存的所有模型 API Key。项目、对话和素材会保留。</p>
          <div className="extension-actions">
            <button type="button" className="button" disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button>
            <button type="button" className="button primary" disabled={clearing} onClick={async () => {
              setClearing(true); setNotice("");
              try {
                onSaved(await api<PublicSettings>("/settings/keys", { method: "DELETE" }));
                setDraft((current) => ({ ...current, ...emptyKeys }));
                setConfirmClear(false);
                setNotice("已清空模型密钥");
              } catch (e) { setNotice((e as Error).message); }
              finally { setClearing(false); }
            }}>{clearing ? "正在清理数据库…" : "确认清空"}</button>
          </div>
        </> : <button type="button" className="button" disabled={busy} onClick={() => { setConfirmClear(true); setNotice(""); }}>清空已保存的模型密钥</button>}
      </div>
      {notice && <p className="form-notice" role="status">{notice}</p>}
    </div>
    <div className="modal-footer"><button className="button" disabled={(!draft.textApiKey.trim() && !value.textConnected) || busy || confirmClear} onClick={async () => {
      setTesting(true); setNotice(""); try { await api("/settings/test", { method: "POST", body: JSON.stringify(draft) }); setNotice("DeepSeek Flash 连接成功"); } catch (e) { setNotice((e as Error).message); } finally { setTesting(false); }
    }}>{testing ? "测试中" : "测试 DeepSeek"}</button><div className="toolbar-spacer"/><button className="button primary" disabled={busy || confirmClear} onClick={async () => {
      setSaving(true); setNotice("");
      try { onSaved(await api<PublicSettings>("/settings", { method: "PUT", body: JSON.stringify(draft) })); onClose(); }
      catch (e) { setNotice((e as Error).message); } finally { setSaving(false); }
    }}>{saving ? "保存中" : "保存"}</button></div>
  </Modal>;
}
