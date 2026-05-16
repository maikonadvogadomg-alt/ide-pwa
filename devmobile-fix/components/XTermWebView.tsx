import React, { useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useApiBase } from "@/hooks/useApiBase";

// Converte URL HTTP → WS para o WebSocket terminal
function toWsUrl(apiBase: string): string {
  return apiBase
    .replace(/\/api\/?$/, "")
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    + "/api/ws/terminal";
}

// HTML completo com xterm.js INLINE (sem CDN — funciona offline e sem CORS)
function buildHtml(wsUrl: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Terminal Linux</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:100%; height:100%; background:#0d1117; overflow:hidden; }
#toolbar {
  display:flex; align-items:center; gap:8px; padding:7px 12px;
  background:#161b22; border-bottom:1px solid #21262d;
  font-family:-apple-system,'Segoe UI',sans-serif; height:38px; flex-shrink:0;
}
#dot { width:9px; height:9px; border-radius:50%; background:#30363d; flex-shrink:0; transition:background .3s; }
#dot.connecting { background:#d29922; animation:pulse 1.2s ease-in-out infinite; }
#dot.connected   { background:#3fb950; }
#dot.error       { background:#f85149; }
#dot.disconnected{ background:#6e7681; }
#status { font-size:11px; color:#8b949e; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#btn-reconnect {
  background:none; border:1px solid #30363d; color:#8b949e; border-radius:6px;
  padding:2px 8px; font-size:10px; cursor:pointer; flex-shrink:0;
}
#btn-reconnect:hover { background:#21262d; color:#e6edf3; }
#btn-clear {
  background:none; border:none; color:#6e7681; cursor:pointer; padding:2px 6px; flex-shrink:0;
}
#terminal-wrap {
  position:absolute; top:38px; left:0; right:0; bottom:0;
  display:flex; flex-direction:column;
}
#terminal-container { flex:1; min-height:0; }
.xterm { height:100% !important; }
.xterm-viewport { overflow-y:auto !important; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

/* Spinner de carregamento */
#loader {
  position:absolute; inset:0; background:#0d1117;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; z-index:10;
}
#loader.hidden { display:none; }
.spin {
  width:32px; height:32px; border:3px solid #21262d;
  border-top-color:#3fb950; border-radius:50%; animation:spin .7s linear infinite;
}
#loader-msg { color:#8b949e; font-size:13px; font-family:-apple-system,sans-serif; }
@keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>

<div id="toolbar">
  <span id="dot" class="connecting"></span>
  <span id="status">Carregando terminal...</span>
  <button id="btn-clear" title="Limpar">✕</button>
  <button id="btn-reconnect">↺ Reconectar</button>
</div>

<div id="terminal-wrap">
  <div id="terminal-container"></div>
</div>

<div id="loader">
  <div class="spin"></div>
  <div id="loader-msg">Carregando xterm.js...</div>
</div>

<!-- xterm.js via CDN com fallback de reconexão -->
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"
  onerror="document.getElementById('loader-msg').textContent='Sem internet — tente reconectar'"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js"></script>

<script>
(function() {
  'use strict';
  const WS_URL = "${wsUrl}";

  const dot        = document.getElementById('dot');
  const statusEl   = document.getElementById('status');
  const loader     = document.getElementById('loader');
  const loaderMsg  = document.getElementById('loader-msg');
  const btnRecon   = document.getElementById('btn-reconnect');
  const btnClear   = document.getElementById('btn-clear');

  let ws         = null;
  let term       = null;
  let fitAddon   = null;
  let sessionN   = 0;
  let autoReconTimer = null;
  let closed     = false;

  /* ── notify React Native ───────────────────────────────────── */
  function postRN(obj) {
    try {
      if (window.ReactNativeWebView)
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch(e) {}
  }

  function setState(s, msg) {
    dot.className = s;
    statusEl.textContent = msg;
    postRN({ type:'state', state:s, msg });
  }

  /* ── xterm init ────────────────────────────────────────────── */
  function initTerm() {
    if (!window.Terminal) {
      loaderMsg.textContent = 'xterm.js não carregou — verifique a internet';
      return false;
    }
    if (term) { try { term.dispose(); } catch(e) {} }

    term = new Terminal({
      theme: {
        background:'#0d1117', foreground:'#e6edf3', cursor:'#a78bfa',
        cursorAccent:'#0d1117', selectionBackground:'#388bfd40',
        black:'#161b22',   brightBlack:'#6e7681',
        red:'#ff7b72',     brightRed:'#ffa198',
        green:'#3fb950',   brightGreen:'#56d364',
        yellow:'#d29922',  brightYellow:'#e3b341',
        blue:'#388bfd',    brightBlue:'#79c0ff',
        magenta:'#bc8cff', brightMagenta:'#d2a8ff',
        cyan:'#39c5cf',    brightCyan:'#56d4dd',
        white:'#b1bac4',   brightWhite:'#f0f6fc',
      },
      fontFamily: "'Fira Code','Cascadia Code','Consolas','Courier New',monospace",
      fontSize: 13, lineHeight: 1.45,
      cursorBlink: true, cursorStyle: 'block',
      scrollback: 10000,
      allowProposedApi: true,
      convertEol: false,
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinks = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);

    const container = document.getElementById('terminal-container');
    term.open(container);
    setTimeout(() => { try { fitAddon.fit(); } catch(e) {} }, 60);

    term.onData(d => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    term.onResize(({cols,rows}) => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({type:'resize',cols,rows}));
    });

    const ro = new ResizeObserver(() => { try { fitAddon.fit(); } catch(e) {} });
    ro.observe(container);
    window.addEventListener('resize', () => { try { fitAddon.fit(); } catch(e) {} });

    return true;
  }

  /* ── WebSocket ─────────────────────────────────────────────── */
  function connect() {
    if (closed) return;
    clearTimeout(autoReconTimer);
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }

    sessionN++;
    setState('connecting', 'Conectando... (sessão #' + sessionN + ')');

    try {
      ws = new WebSocket(WS_URL);
    } catch(e) {
      setState('error', 'URL inválida: ' + WS_URL);
      term && term.writeln('\\r\\n\\x1b[31m✗ URL do WebSocket inválida: ' + WS_URL + '\\x1b[0m\\r');
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setState('connected', '🐧 Linux — bash, node, python, git, npm  (sessão #' + sessionN + ')');
      try { fitAddon && fitAddon.fit(); } catch(e) {}
      try { ws.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows})); } catch(e) {}
    };

    ws.onmessage = ev => {
      if (!term) return;
      try {
        if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
        else term.write(ev.data);
      } catch(e) {}
    };

    ws.onerror = () => {
      setState('error', '✗ Erro de conexão — reconectando...');
      term && term.writeln('\\r\\n\\x1b[31m[✗ WebSocket error — tentando reconectar...]\\x1b[0m\\r');
      scheduleReconnect(3000);
    };

    ws.onclose = e => {
      if (closed) return;
      const clean = e.wasClean ? '' : ' (anormal)';
      setState('disconnected', 'Desconectado' + clean + ' — reconectando...');
      term && term.writeln('\\r\\n\\x1b[90m[Sessão encerrada cod=' + e.code + clean + ']\\x1b[0m\\r');
      scheduleReconnect(e.wasClean ? 5000 : 2500);
    };
  }

  function scheduleReconnect(ms) {
    ms = ms || 4000;
    clearTimeout(autoReconTimer);
    if (!closed) autoReconTimer = setTimeout(connect, ms);
  }

  /* ── Botões ────────────────────────────────────────────────── */
  btnRecon.onclick = () => { closed = false; connect(); };
  btnClear.onclick = () => { if (term) term.clear(); };

  /* ── Mensagens do React Native ─────────────────────────────── */
  function handleMsg(raw) {
    try {
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.data);
      if (msg.type === 'reconnect') { closed = false; connect(); }
      if (msg.type === 'close')     { closed = true; clearTimeout(autoReconTimer); if(ws) ws.close(); }
      if (msg.type === 'cmd' && ws && ws.readyState === WebSocket.OPEN)
        ws.send(msg.data + '\\n');
      if (msg.type === 'resize' && term)
        term.resize(msg.cols || term.cols, msg.rows || term.rows);
    } catch(e) {}
  }
  document.addEventListener('message', handleMsg);
  window.addEventListener('message', handleMsg);

  /* ── Bootstrap ─────────────────────────────────────────────── */
  function boot() {
    loaderMsg.textContent = 'Inicializando terminal...';
    if (!initTerm()) return;
    loader.classList.add('hidden');
    connect();
  }

  // Aguarda xterm.js carregar (pode estar carregando do CDN)
  if (window.Terminal) {
    boot();
  } else {
    loaderMsg.textContent = 'Aguardando xterm.js...';
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (window.Terminal) { clearInterval(poll); boot(); }
      else if (tries > 40) {
        clearInterval(poll);
        loaderMsg.textContent = 'Falha ao carregar xterm.js — verifique internet';
        setState('error', 'xterm.js não carregou');
      }
    }, 200);
  }

})();
</script>
</body>
</html>`;
}

interface XTermWebViewProps {
  style?: object;
  onClose?: () => void;
}

export default function XTermWebView({ style, onClose }: XTermWebViewProps) {
  const colors = useColors();
  const apiBase = useApiBase();
  const webViewRef = useRef<WebView>(null);
  const [wsState, setWsState] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");

  const wsUrl = apiBase ? toWsUrl(apiBase) : "";
  const htmlContent = wsUrl ? buildHtml(wsUrl) : "";

  const handleMessage = useCallback((ev: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(ev.nativeEvent.data);
      if (msg.type === "state") {
        setWsState(msg.state as any);
      }
    } catch {}
  }, []);

  const reconnect = () => {
    webViewRef.current?.postMessage(JSON.stringify({ type: "reconnect" }));
  };

  const stateColor = {
    connecting: "#facc15",
    connected: "#4ade80",
    disconnected: "#64748b",
    error: "#f87171",
  }[wsState];

  const stateLabel = {
    connecting: "Conectando...",
    connected: "Conectado",
    disconnected: "Desconectado",
    error: "Erro",
  }[wsState];

  if (!apiBase) {
    return (
      <View style={[styles.noServer, { backgroundColor: colors.background }]}>
        <Feather name="alert-triangle" size={32} color="#f59e0b" />
        <Text style={[styles.noServerTitle, { color: colors.foreground }]}>
          Servidor não configurado
        </Text>
        <Text style={{ color: colors.mutedForeground, fontSize: 13, textAlign: "center", lineHeight: 20, marginTop: 8, paddingHorizontal: 20 }}>
          O Terminal Linux real precisa de um servidor.{"\n"}
          Configure o endereço em{" "}
          <Text style={{ color: colors.primary, fontWeight: "700" }}>Configurações → API</Text>.{"\n\n"}
          Você pode usar o terminal <Text style={{ color: colors.accent, fontWeight: "700" }}>local (JS/SQL)</Text> sem servidor.
        </Text>
        {onClose && (
          <TouchableOpacity
            onPress={onClose}
            style={[styles.closeBtn, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          >
            <Text style={{ color: colors.foreground, fontWeight: "700" }}>← Voltar ao terminal local</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {/* Toolbar React Native sobre o WebView */}
      <View style={[styles.toolbar, { backgroundColor: "#1e293b", borderBottomColor: "#334155" }]}>
        <View style={[styles.dot, { backgroundColor: stateColor }]} />
        <Text style={styles.statusText}>{stateLabel}</Text>
        <Text style={styles.urlText} numberOfLines={1}>{wsUrl.replace("wss://", "").replace("ws://", "").slice(0, 30)}</Text>
        <TouchableOpacity onPress={reconnect} style={styles.reconnectBtn}>
          <Feather name="refresh-cw" size={13} color="#94a3b8" />
        </TouchableOpacity>
        {onClose && (
          <TouchableOpacity onPress={onClose} style={styles.reconnectBtn}>
            <Feather name="x" size={15} color="#94a3b8" />
          </TouchableOpacity>
        )}
      </View>

      {wsState === "connecting" && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator color="#a78bfa" size="small" />
          <Text style={{ color: "#94a3b8", fontSize: 12, marginTop: 6 }}>Carregando xterm.js...</Text>
        </View>
      )}

      <WebView
        ref={webViewRef}
        style={{ flex: 1, backgroundColor: "#0f172a" }}
        originWhitelist={["*"]}
        source={{ html: htmlContent, baseUrl: "https://cdn.jsdelivr.net" }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        allowFileAccess
        allowUniversalAccessFromFileURLs
        mediaPlaybackRequiresUserAction={false}
        onError={() => setWsState("error")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { fontSize: 11, color: "#94a3b8", minWidth: 80 },
  urlText: { fontSize: 10, color: "#475569", flex: 1 },
  reconnectBtn: { padding: 4 },
  loadingOverlay: {
    position: "absolute",
    top: 40, left: 0, right: 0, bottom: 0,
    alignItems: "center", justifyContent: "center",
    zIndex: 10,
  },
  noServer: {
    flex: 1, alignItems: "center", justifyContent: "center", gap: 12,
  },
  noServerTitle: { fontSize: 17, fontWeight: "700", textAlign: "center" },
  closeBtn: {
    marginTop: 16, paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1,
  },
});
