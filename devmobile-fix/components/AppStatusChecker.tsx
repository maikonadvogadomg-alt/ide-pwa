/**
 * AppStatusChecker — Verifica se o app está pronto para funcionar sem Replit.
 *
 * Verifica:
 *  1. Chave Gemini (formato + teste ao vivo)
 *  2. Banco Neon (conexão direta via HTTP API)
 *  3. Tabelas SQLite locais (dm_conversas, dm_mensagens, etc.)
 *  4. Servidor externo (opcional)
 */

import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { listTables } from "@/services/localSQLite";

// ─── Tipos ────────────────────────────────────────────────────────────────────
type Status = "idle" | "checking" | "ok" | "warn" | "error";

interface CheckItem {
  id: string;
  label: string;
  sublabel: string;
  status: Status;
  detail?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseConnectionString(connStr: string): { user: string; password: string; host: string } | null {
  try {
    const url = new URL(connStr.replace(/^postgresql:\/\//, "postgres://"));
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
    };
  } catch {
    return null;
  }
}

async function testNeonDirect(connStr: string): Promise<{ ok: boolean; ms: number; message: string }> {
  const parsed = parseConnectionString(connStr);
  if (!parsed) return { ok: false, ms: 0, message: "Connection string inválida" };
  const t0 = Date.now();
  const basicAuth = btoa(`${parsed.user}:${parsed.password}`);
  const resp = await fetch(`https://${parsed.host}/sql/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basicAuth}`,
      "Neon-Connection-String": connStr,
    },
    body: JSON.stringify({ query: "SELECT NOW() AS t", params: [] }),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const text = await resp.text().catch(() => `HTTP ${resp.status}`);
    return { ok: false, ms, message: text.substring(0, 100) };
  }
  return { ok: true, ms, message: `Conectado em ${ms}ms` };
}

async function testGeminiKey(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "responda somente: ok" }] }] }),
      }
    );
    if (resp.ok) return { ok: true, message: "Chave válida — Gemini respondeu" };
    const j = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    return { ok: false, message: j?.error?.message || `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Erro de rede" };
  }
}

// ─── Componente ───────────────────────────────────────────────────────────────
export default function AppStatusChecker() {
  const colors = useColors();
  const { settings, dbConfigs } = useApp();

  const [checks, setChecks] = useState<CheckItem[]>([
    { id: "gemini",  label: "Gemini (IA Offline)", sublabel: "Chave do Google AI Studio", status: "idle" },
    { id: "neon",    label: "Banco Neon (Nuvem)",  sublabel: "Conexão HTTP direta — sem servidor", status: "idle" },
    { id: "sqlite",  label: "SQLite Local",         sublabel: "Tabelas dm_ no celular", status: "idle" },
    { id: "server",  label: "Servidor Replit",      sublabel: "Opcional — funciona sem ele", status: "idle" },
  ]);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const setCheck = (id: string, patch: Partial<CheckItem>) => {
    setChecks(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c));
  };

  const runAllChecks = useCallback(async () => {
    if (running) return;
    setRunning(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Reset tudo para "checking"
    setChecks(prev => prev.map(c => ({ ...c, status: "checking", detail: undefined })));

    // ── 1. Gemini ──────────────────────────────────────────────────────────────
    const geminiKey = settings.geminiDirectKey?.trim();
    if (!geminiKey) {
      setCheck("gemini", { status: "error", detail: "Nenhuma chave configurada.\nConfigure em 'GEMINI DIRETO DO CELULAR'." });
    } else if (!geminiKey.startsWith("AIza")) {
      setCheck("gemini", { status: "warn", detail: "Formato suspeito — chave Gemini começa com 'AIza'." });
    } else {
      const r = await testGeminiKey(geminiKey);
      setCheck("gemini", {
        status: r.ok ? "ok" : "error",
        detail: r.message,
      });
    }

    // ── 2. Neon DB ────────────────────────────────────────────────────────────
    const neonConfig = dbConfigs.find(d => d.provider === "neon" || d.provider === "postgres");
    if (!neonConfig) {
      setCheck("neon", { status: "warn", detail: "Nenhuma conexão Neon salva.\nAdicione em Banco de Dados → Painel DB → Aba NEON." });
    } else {
      try {
        const r = await testNeonDirect(neonConfig.connectionString);
        setCheck("neon", {
          status: r.ok ? "ok" : "error",
          detail: r.ok ? `${neonConfig.name}: ${r.message}` : r.message,
        });
      } catch (e) {
        setCheck("neon", { status: "error", detail: e instanceof Error ? e.message : "Falha na conexão" });
      }
    }

    // ── 3. SQLite local ───────────────────────────────────────────────────────
    try {
      const tables = await listTables();
      const appTables = ["dm_conversas", "dm_mensagens", "dm_templates", "dm_playground", "dm_projetos"];
      const found = appTables.filter(t => tables.includes(t));
      const missing = appTables.filter(t => !tables.includes(t));
      if (found.length === appTables.length) {
        setCheck("sqlite", { status: "ok", detail: `${found.length}/5 tabelas presentes:\n${found.join(", ")}` });
      } else if (found.length > 0) {
        setCheck("sqlite", { status: "warn", detail: `${found.length}/5 tabelas.\nFaltam: ${missing.join(", ")}\nUse 'Criar todas as tabelas' no Banco Local.` });
      } else {
        setCheck("sqlite", { status: "warn", detail: `Tabelas do app não criadas ainda.\nVá em Banco de Dados → LOCAL → 'Criar todas as tabelas'.` });
      }
    } catch (e) {
      setCheck("sqlite", { status: "error", detail: e instanceof Error ? e.message : "Erro ao verificar SQLite" });
    }

    // ── 4. Servidor (opcional) ────────────────────────────────────────────────
    const serverUrl = settings.customServerUrl?.trim() || "https://sk-code-editor.replit.app";
    try {
      const t0 = Date.now();
      const resp = await fetch(`${serverUrl}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], model: "gemini-2.0-flash-lite" }),
        signal: AbortSignal.timeout(6000),
      });
      const ms = Date.now() - t0;
      // Qualquer resposta (mesmo erro de payload) = servidor online
      setCheck("server", { status: "ok", detail: `Online em ${ms}ms — funciona como backup do Gemini.` });
    } catch {
      setCheck("server", {
        status: "warn",
        detail: "Servidor offline ou sem conexão — OK!\nO app funciona 100% sem servidor.",
      });
    }

    setRunning(false);
    setLastRun(new Date().toLocaleTimeString("pt-BR"));
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [running, settings, dbConfigs]);

  // ─── Render ─────────────────────────────────────────────────────────────────
  const statusColor = (s: Status) => {
    if (s === "ok")       return "#22c55e";
    if (s === "warn")     return "#f59e0b";
    if (s === "error")    return "#ef4444";
    if (s === "checking") return "#60a5fa";
    return colors.mutedForeground;
  };

  const statusIcon = (s: Status): keyof typeof Feather.glyphMap => {
    if (s === "ok")    return "check-circle";
    if (s === "warn")  return "alert-triangle";
    if (s === "error") return "x-circle";
    return "circle";
  };

  const allOk = checks.every(c => c.status === "ok" || c.status === "warn");
  const anyError = checks.some(c => c.status === "error");
  const hasRun = checks.some(c => c.status !== "idle");

  const summaryColor = anyError ? "#ef4444" : allOk ? "#22c55e" : colors.mutedForeground;
  const summaryText = anyError
    ? "Atenção — alguns itens precisam de configuração"
    : allOk
    ? "Tudo OK — app pronto para funcionar offline"
    : "Toque em 'Verificar Tudo' para checar o status";

  return (
    <View
      style={{
        margin: 12,
        borderRadius: 14,
        borderWidth: 1.5,
        borderColor: anyError ? "#ef444444" : allOk && hasRun ? "#22c55e44" : colors.border,
        backgroundColor: colors.card,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 14,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: anyError ? "#2d000010" : allOk && hasRun ? "#00200010" : colors.card,
        }}
      >
        <View
          style={{
            width: 36, height: 36, borderRadius: 10,
            backgroundColor: anyError ? "#ef444422" : allOk && hasRun ? "#22c55e22" : colors.secondary,
            alignItems: "center", justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 18 }}>
            {anyError ? "⚠️" : allOk && hasRun ? "✅" : "🔍"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 14 }}>
            Verificar Configurações
          </Text>
          <Text style={{ color: summaryColor, fontSize: 11, marginTop: 1 }}>
            {summaryText}
          </Text>
        </View>
        {lastRun && (
          <Text style={{ color: colors.mutedForeground, fontSize: 10 }}>{lastRun}</Text>
        )}
      </View>

      {/* Lista de checks */}
      <View style={{ padding: 10, gap: 6 }}>
        {checks.map((item) => (
          <View
            key={item.id}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 10,
              backgroundColor: colors.background,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: item.status !== "idle" ? `${statusColor(item.status)}33` : colors.border,
            }}
          >
            <View style={{ width: 22, alignItems: "center", paddingTop: 1 }}>
              {item.status === "checking" ? (
                <ActivityIndicator size={16} color="#60a5fa" />
              ) : (
                <Feather
                  name={statusIcon(item.status)}
                  size={16}
                  color={statusColor(item.status)}
                />
              )}
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>
                  {item.label}
                </Text>
                {item.id === "server" && (
                  <Text style={{ color: colors.mutedForeground, fontSize: 10, fontStyle: "italic" }}>
                    opcional
                  </Text>
                )}
              </View>
              <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 1 }}>
                {item.sublabel}
              </Text>
              {item.detail && item.status !== "idle" && (
                <Text
                  style={{
                    color: statusColor(item.status),
                    fontSize: 11,
                    marginTop: 5,
                    lineHeight: 16,
                    backgroundColor: `${statusColor(item.status)}11`,
                    borderRadius: 6,
                    padding: 6,
                  }}
                >
                  {item.detail}
                </Text>
              )}
            </View>
          </View>
        ))}
      </View>

      {/* Botão verificar */}
      <TouchableOpacity
        onPress={runAllChecks}
        disabled={running}
        style={{
          margin: 10,
          marginTop: 4,
          padding: 13,
          borderRadius: 10,
          backgroundColor: running ? colors.muted : colors.primary,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        {running ? (
          <>
            <ActivityIndicator size={16} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>Verificando...</Text>
          </>
        ) : (
          <>
            <Feather name="zap" size={15} color="#000" />
            <Text style={{ color: "#000", fontWeight: "700", fontSize: 14 }}>
              {hasRun ? "Verificar Novamente" : "Verificar Tudo"}
            </Text>
          </>
        )}
      </TouchableOpacity>

      {/* Dica */}
      {hasRun && !running && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 11, textAlign: "center", lineHeight: 16 }}>
            {anyError
              ? "Configure os itens em vermelho acima para o app funcionar offline."
              : "O app está configurado para funcionar sem internet e sem Replit."}
          </Text>
        </View>
      )}
    </View>
  );
}
