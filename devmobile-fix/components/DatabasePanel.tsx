/**
 * DatabasePanel — Gerenciador visual de banco de dados para DevMobile
 *
 * Aba LOCAL  → SQLite embutido no celular (expo-sqlite). Persiste no dispositivo.
 * Aba NEON   → PostgreSQL na nuvem. Direto do celular via HTTP API — sem servidor.
 *
 * Sem servidor: SQLite funciona 100% offline. Neon funciona via HTTP API direta.
 * Com servidor: todas as funcionalidades disponíveis.
 */

import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { useApiBase } from "@/hooks/useApiBase";
import { runSQL, formatSQLResult, listTables, switchDatabase, getCurrentDbName } from "@/services/localSQLite";
import type { DBConfig } from "@/context/AppContext";

// ─── SQL para criar todas as tabelas do app ────────────────────────────────────
const APP_TABLES_SQLITE = `
CREATE TABLE IF NOT EXISTS dm_conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id TEXT,
  titulo TEXT NOT NULL DEFAULT 'Conversa',
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS dm_mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id INTEGER REFERENCES dm_conversas(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS dm_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  conteudo TEXT NOT NULL,
  tipo TEXT DEFAULT 'projeto',
  criado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS dm_playground (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL DEFAULT 'Playground',
  html TEXT DEFAULT '',
  css TEXT DEFAULT '',
  js TEXT DEFAULT '',
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS dm_projetos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  arquivos TEXT,
  criado_em TEXT DEFAULT (datetime('now','localtime')),
  atualizado_em TEXT DEFAULT (datetime('now','localtime'))
);
`.trim();

const APP_TABLES_NEON = `
CREATE TABLE IF NOT EXISTS dm_conversas (
  id SERIAL PRIMARY KEY,
  projeto_id TEXT,
  titulo TEXT NOT NULL DEFAULT 'Conversa',
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dm_mensagens (
  id SERIAL PRIMARY KEY,
  conversa_id INTEGER REFERENCES dm_conversas(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dm_templates (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  conteudo TEXT NOT NULL,
  tipo TEXT DEFAULT 'projeto',
  criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dm_playground (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL DEFAULT 'Playground',
  html TEXT DEFAULT '',
  css TEXT DEFAULT '',
  js TEXT DEFAULT '',
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS dm_projetos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  arquivos JSONB,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);
`.trim();

// ─── Conexão direta com Neon via HTTP API (sem servidor) ──────────────────────
function parseConnectionString(connStr: string): { user: string; password: string; host: string; database: string } | null {
  try {
    const url = new URL(connStr.replace(/^postgresql:\/\//, "postgres://"));
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      database: url.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

async function runNeonDirect(connStr: string, sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const parsed = parseConnectionString(connStr);
  if (!parsed) throw new Error("Connection string inválida");

  const basicAuth = btoa(`${parsed.user}:${parsed.password}`);
  const endpoint = `https://${parsed.host}/sql/v1`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basicAuth}`,
      "Neon-Connection-String": connStr,
    },
    body: JSON.stringify({ query: sql, params: [] }),
  });

  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json() as { message?: string; error?: string };
      msg = j.message || j.error || msg;
    } catch {}
    throw new Error(msg);
  }

  const data = await resp.json() as { rows?: Record<string, unknown>[]; rowCount?: number; command?: string };
  return { rows: data.rows ?? [], rowCount: data.rowCount ?? (data.rows?.length ?? 0) };
}

// ─── Tipos ────────────────────────────────────────────────────────────────────
type DbTab = "local" | "neon";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  isSelect: boolean;
  message?: string;
  error?: string;
  latencyMs?: number;
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function DatabasePanel() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const apiBase = useApiBase();
  const { dbConfigs, addDBConfig, removeDBConfig, activeProject } = useApp();

  const [activeTab, setActiveTab] = useState<DbTab>("local");

  // ── Estado LOCAL SQLite ──────────────────────────────────────────────────────
  const [localTables, setLocalTables] = useState<string[]>([]);
  const [localQuery, setLocalQuery] = useState("");
  const [localResult, setLocalResult] = useState<QueryResult | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localDbName, setLocalDbName] = useState(getCurrentDbName());
  const [showDbSwitcher, setShowDbSwitcher] = useState(false);
  const [newDbName, setNewDbName] = useState("");

  // ── Estado NEON ──────────────────────────────────────────────────────────────
  const [neonConnStr, setNeonConnStr] = useState("");
  const [neonQuery, setNeonQuery] = useState("");
  const [neonResult, setNeonResult] = useState<QueryResult | null>(null);
  const [neonLoading, setNeonLoading] = useState(false);
  const [neonConnected, setNeonConnected] = useState(false);
  const [neonConnName, setNeonConnName] = useState("");
  const [neonTables, setNeonTables] = useState<string[]>([]);
  const [neonTestResult, setNeonTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAddNeon, setShowAddNeon] = useState(false);
  const [selectedNeonConfig, setSelectedNeonConfig] = useState<DBConfig | null>(null);

  // ── Template de queries rápidas ──────────────────────────────────────────────
  const QUICK_LOCAL = [
    { label: "Listar tabelas", sql: "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" },
    { label: "Criar tabela exemplo", sql: "CREATE TABLE IF NOT EXISTS tarefas (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  titulo TEXT NOT NULL,\n  feito INTEGER DEFAULT 0,\n  criado_em TEXT DEFAULT (datetime('now','localtime'))\n)" },
    { label: "Inserir exemplo", sql: "INSERT INTO tarefas (titulo) VALUES ('Minha primeira tarefa')" },
    { label: "Selecionar tudo", sql: "SELECT * FROM tarefas ORDER BY id DESC LIMIT 100" },
    { label: "Info do banco", sql: "PRAGMA database_list" },
    { label: "Tamanho das tabelas", sql: "SELECT name, (SELECT COUNT(*) FROM sqlite_master m2 WHERE m2.name=m1.name) as linhas FROM sqlite_master m1 WHERE type='table' AND name NOT LIKE 'sqlite_%'" },
  ];

  const QUICK_NEON = [
    { label: "Listar tabelas", sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name" },
    { label: "Versão PostgreSQL", sql: "SELECT version()" },
    { label: "Criar tabela exemplo", sql: "CREATE TABLE IF NOT EXISTS tarefas (\n  id SERIAL PRIMARY KEY,\n  titulo TEXT NOT NULL,\n  feito BOOLEAN DEFAULT FALSE,\n  criado_em TIMESTAMPTZ DEFAULT NOW()\n)" },
    { label: "Inserir exemplo", sql: "INSERT INTO tarefas (titulo) VALUES ('Primeira tarefa') RETURNING *" },
    { label: "Selecionar tudo", sql: "SELECT * FROM tarefas ORDER BY id DESC LIMIT 100" },
    { label: "Tamanho das tabelas", sql: "SELECT relname AS tabela, pg_size_pretty(pg_total_relation_size(relid)) AS tamanho FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC" },
  ];

  // ── Load tabelas locais ──────────────────────────────────────────────────────
  const loadLocalTables = useCallback(async () => {
    try {
      const tables = await listTables();
      setLocalTables(tables);
    } catch {}
  }, []);

  useEffect(() => {
    loadLocalTables();
    setLocalDbName(getCurrentDbName());
  }, [loadLocalTables]);

  // ── Executar query local ─────────────────────────────────────────────────────
  const runLocalQuery = async (sql?: string) => {
    const q = (sql ?? localQuery).trim();
    if (!q) return;
    setLocalLoading(true);
    setLocalResult(null);
    const t0 = Date.now();
    try {
      const raw = await runSQL(q);
      const cols = raw.isSelect && raw.rows.length > 0 ? Object.keys(raw.rows[0]) : [];
      setLocalResult({
        columns: cols,
        rows: raw.rows,
        rowCount: raw.isSelect ? raw.rows.length : (raw.changes ?? 0),
        isSelect: raw.isSelect,
        message: raw.isSelect ? undefined : `✅ ${raw.changes ?? 0} linha(s) afetada(s)${raw.lastInsertRowId ? ` · ID=${raw.lastInsertRowId}` : ""}`,
        latencyMs: Date.now() - t0,
      });
      await loadLocalTables();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalResult({ columns: [], rows: [], rowCount: 0, isSelect: false, error: msg, latencyMs: Date.now() - t0 });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLocalLoading(false);
    }
  };

  // ── Trocar banco de dados local ──────────────────────────────────────────────
  const handleSwitchDb = async (name: string) => {
    try {
      await switchDatabase(name);
      setLocalDbName(getCurrentDbName());
      setLocalTables([]);
      setLocalResult(null);
      await loadLocalTables();
      setShowDbSwitcher(false);
      setNewDbName("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      Alert.alert("Erro", e instanceof Error ? e.message : "Erro ao trocar banco");
    }
  };

  // ── Executar query Neon (direto via HTTP API, sem servidor) ──────────────────
  const runNeonQuery = async (sql?: string) => {
    const q = (sql ?? neonQuery).trim();
    const conn = selectedNeonConfig?.connectionString ?? neonConnStr;
    if (!q || !conn) return;

    setNeonLoading(true);
    setNeonResult(null);
    const t0 = Date.now();
    try {
      let rows: Record<string, unknown>[] = [];
      let rowCount = 0;

      // Tenta direto via HTTP API do Neon primeiro (sem servidor)
      try {
        const result = await runNeonDirect(conn, q);
        rows = result.rows;
        rowCount = result.rowCount;
      } catch (directErr) {
        // Se falhar e tiver servidor disponível, tenta via proxy
        if (apiBase) {
          const resp = await fetch(`${apiBase}/api/db/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionString: conn, sql: q }),
          });
          const data = await resp.json() as { success?: boolean; rows?: Record<string, unknown>[]; rowCount?: number; message?: string };
          if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
          rows = data.rows || [];
          rowCount = data.rowCount ?? rows.length;
        } else {
          throw directErr;
        }
      }

      const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
      const isSelect = /^\s*(SELECT|WITH|SHOW|EXPLAIN)/i.test(q);
      setNeonResult({
        columns: cols,
        rows,
        rowCount,
        isSelect,
        message: isSelect ? undefined : `✅ ${rowCount} linha(s) afetada(s)`,
        latencyMs: Date.now() - t0,
      });
      if (isSelect && /information_schema\.tables/i.test(q)) {
        setNeonTables(rows.map(r => String(r.table_name || r.TABLE_NAME || "")));
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setNeonResult({ columns: [], rows: [], rowCount: 0, isSelect: false, error: msg, latencyMs: Date.now() - t0 });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setNeonLoading(false);
    }
  };

  // ── Testar conexão Neon (direto, sem servidor) ────────────────────────────────
  const testNeonConnection = async () => {
    const conn = neonConnStr.trim();
    if (!conn) return;
    const t0 = Date.now();
    try {
      // Tenta direto via HTTP API
      const result = await runNeonDirect(conn, "SELECT NOW() AS agora, version() AS versao");
      const ms = Date.now() - t0;
      setNeonTestResult({ ok: true, message: `✅ Conectado em ${ms}ms` });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      // Fallback para servidor se disponível
      if (apiBase) {
        try {
          const resp = await fetch(`${apiBase}/api/db/test-connection`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connectionString: conn }),
          });
          const data = await resp.json() as { ok?: boolean; message?: string };
          setNeonTestResult({ ok: data.ok ?? false, message: data.message || (data.ok ? "Conectado via servidor!" : "Falhou") });
          if (data.ok) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        } catch {}
      }
      setNeonTestResult({ ok: false, message: e instanceof Error ? e.message : "Erro de conexão" });
    }
  };

  // ── Criar tabelas do app no SQLite ───────────────────────────────────────────
  const [creatingLocalTables, setCreatingLocalTables] = useState(false);
  const createLocalAppTables = async () => {
    setCreatingLocalTables(true);
    try {
      const statements = APP_TABLES_SQLITE.split(";").map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        await runSQL(stmt);
      }
      await loadLocalTables();
      Alert.alert("✅ Tabelas criadas!", "dm_conversas, dm_mensagens, dm_templates, dm_playground e dm_projetos criadas no SQLite local.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      Alert.alert("Erro", e instanceof Error ? e.message : "Falha ao criar tabelas");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreatingLocalTables(false);
    }
  };

  // ── Criar tabelas do app no Neon ─────────────────────────────────────────────
  const [creatingNeonTables, setCreatingNeonTables] = useState(false);
  const createNeonAppTables = async () => {
    const conn = selectedNeonConfig?.connectionString ?? neonConnStr;
    if (!conn) {
      Alert.alert("Atenção", "Selecione ou configure uma conexão Neon primeiro.");
      return;
    }
    setCreatingNeonTables(true);
    try {
      const statements = APP_TABLES_NEON.split(";").map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        await runNeonDirect(conn, stmt);
      }
      // Recarrega lista de tabelas
      const result = await runNeonDirect(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
      setNeonTables(result.rows.map(r => String(r.table_name || "")));
      Alert.alert("✅ Tabelas criadas no Neon!", "dm_conversas, dm_mensagens, dm_templates, dm_playground e dm_projetos criadas com sucesso.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: unknown) {
      Alert.alert("Erro", e instanceof Error ? e.message : "Falha ao criar tabelas no Neon");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreatingNeonTables(false);
    }
  };

  // ── Salvar conexão Neon ──────────────────────────────────────────────────────
  const saveNeonConfig = () => {
    const conn = neonConnStr.trim();
    const name = neonConnName.trim() || "Neon DB";
    if (!conn) return;
    addDBConfig({ provider: "neon", connectionString: conn, name });
    setNeonConnStr("");
    setNeonConnName("");
    setNeonTestResult(null);
    setShowAddNeon(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // ── Renderiza resultado como tabela ──────────────────────────────────────────
  const ResultTable = ({ result }: { result: QueryResult }) => {
    if (result.error) {
      return (
        <View style={[styles.errorBox, { backgroundColor: "#2d0000", borderColor: "#ef444433" }]}>
          <Feather name="alert-circle" size={14} color="#f87171" />
          <Text style={{ color: "#f87171", fontSize: 12, flex: 1, lineHeight: 18 }}>{result.error}</Text>
        </View>
      );
    }
    if (!result.isSelect || result.rows.length === 0) {
      return (
        <View style={[styles.infoBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="check-circle" size={14} color={colors.accent} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.accent, fontWeight: "700", fontSize: 13 }}>
              {result.message || "Executado com sucesso"}
            </Text>
            {result.latencyMs != null && (
              <Text style={{ color: colors.mutedForeground, fontSize: 11, marginTop: 2 }}>
                {result.latencyMs}ms
              </Text>
            )}
          </View>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
            {result.rowCount} linha{result.rowCount !== 1 ? "s" : ""} · {result.columns.length} col{result.columns.length !== 1 ? "unas" : "una"}
            {result.latencyMs != null ? ` · ${result.latencyMs}ms` : ""}
          </Text>
          <TouchableOpacity onPress={() => {
            const text = [result.columns.join(" | "), ...result.rows.map(r => result.columns.map(c => String(r[c] ?? "NULL")).join(" | "))].join("\n");
            Clipboard.setStringAsync(text);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}>
            <Text style={{ color: colors.primary, fontSize: 11 }}>Copiar CSV</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ flex: 1 }}>
          <View>
            {/* Header */}
            <View style={[styles.tableRow, { backgroundColor: colors.secondary }]}>
              {result.columns.map(col => (
                <Text key={col} style={[styles.tableCell, styles.tableHeader, { color: colors.accent }]}>{col}</Text>
              ))}
            </View>
            {/* Rows */}
            {result.rows.slice(0, 200).map((row, i) => (
              <View key={i} style={[styles.tableRow, { backgroundColor: i % 2 === 0 ? colors.card : colors.background }]}>
                {result.columns.map(col => (
                  <Text key={col} style={[styles.tableCell, { color: colors.foreground }]} numberOfLines={2}>
                    {row[col] == null ? <Text style={{ color: colors.mutedForeground, fontStyle: "italic" }}>NULL</Text> : String(row[col])}
                  </Text>
                ))}
              </View>
            ))}
            {result.rows.length > 200 && (
              <Text style={{ color: colors.mutedForeground, fontSize: 11, padding: 8, textAlign: "center" }}>
                ... {result.rows.length - 200} linhas omitidas
              </Text>
            )}
          </View>
        </ScrollView>
      </View>
    );
  };

  // ── ABA LOCAL ─────────────────────────────────────────────────────────────────
  const LocalTab = () => (
    <View style={{ flex: 1 }}>
      {/* Header do banco */}
      <View style={[styles.dbHeader, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Feather name="database" size={13} color={colors.accent} />
        <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 13, flex: 1 }}>
          {localDbName}
        </Text>
        <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>
          {localTables.length} tabela{localTables.length !== 1 ? "s" : ""}
        </Text>
        <TouchableOpacity onPress={() => setShowDbSwitcher(v => !v)} style={styles.iconBtn}>
          <Feather name="layers" size={14} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={loadLocalTables} style={styles.iconBtn}>
          <Feather name="refresh-cw" size={13} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      {/* Switcher de banco */}
      {showDbSwitcher && (
        <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 13, marginBottom: 8 }}>
            Trocar banco de dados local
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 8 }}>
            Os dados ficam no dispositivo. Cada banco é um arquivo .db separado.
          </Text>
          <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
            <TextInput
              style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, flex: 1 }]}
              value={newDbName}
              onChangeText={setNewDbName}
              placeholder="Nome do banco (ex: meu_app)"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
            />
            <TouchableOpacity
              onPress={() => newDbName.trim() && handleSwitchDb(newDbName.trim())}
              disabled={!newDbName.trim()}
              style={[styles.btn, { backgroundColor: newDbName.trim() ? colors.primary : colors.muted }]}
            >
              <Text style={{ color: colors.primaryForeground, fontWeight: "700", fontSize: 13 }}>Criar/Abrir</Text>
            </TouchableOpacity>
          </View>
          {/* Bancos salvos nos projetos */}
          {activeProject && (
            <TouchableOpacity
              onPress={() => handleSwitchDb(activeProject.name.toLowerCase().replace(/\s+/g, "_"))}
              style={[styles.dbChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
            >
              <Feather name="folder" size={12} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 12 }}>
                Banco do projeto: {activeProject.name.toLowerCase().replace(/\s+/g, "_")}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => handleSwitchDb("devmobile_local")}
            style={[styles.dbChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          >
            <Feather name="hard-drive" size={12} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 12 }}>devmobile_local (padrão)</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Tabelas existentes */}
      {localTables.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
            {localTables.map(t => (
              <TouchableOpacity
                key={t}
                onPress={() => { setLocalQuery(`SELECT * FROM ${t} LIMIT 100`); }}
                style={[styles.tableChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
              >
                <Feather name="table" size={11} color={colors.accent} />
                <Text style={{ color: colors.foreground, fontSize: 12 }}>{t}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Editor de query */}
      <View style={[styles.queryEditor, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <TextInput
          style={[styles.queryInput, { color: colors.foreground, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}
          value={localQuery}
          onChangeText={setLocalQuery}
          placeholder={"SELECT * FROM tarefas\n-- Use sql> no Terminal ou escreva aqui"}
          placeholderTextColor={colors.mutedForeground}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
        />
        <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 8, gap: 8 }}>
          <TouchableOpacity
            onPress={() => { setLocalQuery(""); setLocalResult(null); }}
            style={[styles.btnSmall, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          >
            <Feather name="trash-2" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={async () => {
              const t = await Clipboard.getStringAsync();
              if (t) setLocalQuery(t);
            }}
            style={[styles.btnSmall, { backgroundColor: colors.secondary, borderColor: colors.border }]}
          >
            <Feather name="clipboard" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => runLocalQuery()}
            disabled={localLoading || !localQuery.trim()}
            style={[styles.runBtn, { backgroundColor: localQuery.trim() ? colors.accent : colors.muted, flex: 1 }]}
          >
            {localLoading
              ? <ActivityIndicator size={14} color="#fff" />
              : <><Feather name="play" size={13} color="#fff" /><Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Executar SQL</Text></>
            }
          </TouchableOpacity>
        </View>
      </View>

      {/* Queries rápidas */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
        <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
          {QUICK_LOCAL.map(q => (
            <TouchableOpacity
              key={q.label}
              onPress={() => { setLocalQuery(q.sql); runLocalQuery(q.sql); }}
              style={[styles.tableChip, { backgroundColor: colors.card, borderColor: colors.primary + "44" }]}
            >
              <Text style={{ color: colors.primary, fontSize: 11 }}>{q.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Resultado */}
      {localResult && (
        <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: colors.border }}>
          <ResultTable result={localResult} />
        </View>
      )}

      {/* Botão criar tabelas do app */}
      <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border, margin: 10 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Feather name="layers" size={14} color={colors.accent} />
          <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 13 }}>Tabelas do DevMobile</Text>
        </View>
        <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 10, lineHeight: 18 }}>
          Cria as tabelas para salvar <Text style={{ color: colors.accent }}>conversas, mensagens, templates, playground e projetos</Text> no SQLite local.
        </Text>
        <TouchableOpacity
          onPress={createLocalAppTables}
          disabled={creatingLocalTables}
          style={[styles.btn, { backgroundColor: colors.accent, opacity: creatingLocalTables ? 0.6 : 1 }]}
        >
          {creatingLocalTables
            ? <ActivityIndicator size={14} color="#fff" />
            : <><Feather name="database" size={13} color="#fff" /><Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Criar todas as tabelas</Text></>
          }
        </TouchableOpacity>
      </View>

      {!localResult && localTables.length === 0 && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
          <Feather name="database" size={40} color={colors.border} />
          <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 16, textAlign: "center" }}>
            Banco local vazio
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 13, textAlign: "center", lineHeight: 20 }}>
            Os dados ficam <Text style={{ color: colors.accent, fontWeight: "700" }}>salvos no seu celular</Text> — mesmo sem internet.{"\n\n"}
            Use <Text style={{ fontWeight: "700", color: colors.accent }}>"Criar todas as tabelas"</Text> acima para criar as tabelas do app, ou toque em{" "}
            <Text style={{ fontWeight: "700", color: colors.primary }}>"Criar tabela exemplo"</Text> para uma tabela de teste.
          </Text>
        </View>
      )}
    </View>
  );

  // ── ABA NEON ──────────────────────────────────────────────────────────────────
  const NeonTab = () => {
    const neonConfigs = dbConfigs.filter(d => d.provider === "neon" || d.provider === "postgres");

    return (
      <View style={{ flex: 1 }}>
        {/* Banner: funciona direto do celular */}
        <View style={[styles.warnBox, { backgroundColor: "#0a1628", borderColor: "#3b82f633" }]}>
          <Feather name="wifi" size={13} color="#60a5fa" />
          <Text style={{ color: "#bfdbfe", fontSize: 12, flex: 1, lineHeight: 18 }}>
            <Text style={{ fontWeight: "700", color: "#93c5fd" }}>Conexão direta</Text> — Neon funciona sem servidor via HTTP API.
            {apiBase ? " Servidor disponível como fallback." : " Cole sua connection string abaixo."}
          </Text>
        </View>

        {/* Conexões salvas */}
        {neonConfigs.length > 0 && (
          <View style={[{ borderBottomWidth: 1, borderBottomColor: colors.border, padding: 10, gap: 6 }]}>
            <Text style={{ color: colors.mutedForeground, fontSize: 11, fontWeight: "700", marginBottom: 2 }}>
              CONEXÕES SALVAS
            </Text>
            {neonConfigs.map(cfg => (
              <TouchableOpacity
                key={cfg.name}
                onPress={() => {
                  setSelectedNeonConfig(cfg);
                  setNeonQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
                  runNeonQuery("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
                }}
                style={[
                  styles.connCard,
                  {
                    backgroundColor: selectedNeonConfig?.name === cfg.name ? colors.primary + "18" : colors.card,
                    borderColor: selectedNeonConfig?.name === cfg.name ? colors.primary : colors.border,
                  }
                ]}
              >
                <Feather name="cloud" size={13} color={selectedNeonConfig?.name === cfg.name ? colors.primary : colors.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 13 }}>{cfg.name}</Text>
                  <Text style={{ color: colors.mutedForeground, fontSize: 10 }} numberOfLines={1}>
                    {cfg.connectionString.replace(/:[^:@]+@/, ":***@")}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => {
                    Alert.alert("Remover conexão", `Remover "${cfg.name}"?`, [
                      { text: "Cancelar", style: "cancel" },
                      { text: "Remover", style: "destructive", onPress: () => { removeDBConfig(cfg.name); if (selectedNeonConfig?.name === cfg.name) setSelectedNeonConfig(null); } },
                    ]);
                  }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="trash-2" size={13} color={colors.mutedForeground} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Adicionar nova conexão */}
        {(showAddNeon || neonConfigs.length === 0) && (
          <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border, margin: 10 }]}>
            <Text style={{ color: colors.foreground, fontWeight: "700", fontSize: 14, marginBottom: 4 }}>
              Conectar ao Neon PostgreSQL
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
              Cole a connection string do Neon.{"\n"}
              Obtenha gratuitamente em{" "}
              <Text style={{ color: colors.primary }}>neon.tech → Connection Details</Text>
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 4 }}>Nome da conexão</Text>
            <TextInput
              style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, marginBottom: 10 }]}
              value={neonConnName}
              onChangeText={setNeonConnName}
              placeholder="Meu banco Neon"
              placeholderTextColor={colors.mutedForeground}
            />
            <Text style={{ color: colors.mutedForeground, fontSize: 11, marginBottom: 4 }}>Connection String</Text>
            <TextInput
              style={[styles.input, styles.connInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border, marginBottom: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}
              value={neonConnStr}
              onChangeText={(t) => { setNeonConnStr(t); setNeonTestResult(null); }}
              placeholder="postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require"
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            {neonTestResult && (
              <View style={[styles.infoBox, {
                backgroundColor: neonTestResult.ok ? "#0d2d0d" : "#2d0000",
                borderColor: neonTestResult.ok ? "#22c55e33" : "#ef444433",
                marginBottom: 10,
              }]}>
                <Feather name={neonTestResult.ok ? "check-circle" : "x-circle"} size={14} color={neonTestResult.ok ? "#22c55e" : "#f87171"} />
                <Text style={{ color: neonTestResult.ok ? "#22c55e" : "#f87171", fontSize: 12, flex: 1 }}>
                  {neonTestResult.message}
                </Text>
              </View>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                onPress={testNeonConnection}
                disabled={!neonConnStr.trim()}
                style={[styles.btn, { backgroundColor: neonConnStr.trim() ? "#1d4ed8" : colors.muted }]}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Testar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveNeonConfig}
                disabled={!neonConnStr.trim()}
                style={[styles.btn, { backgroundColor: neonConnStr.trim() ? colors.primary : colors.muted, flex: 1 }]}
              >
                <Feather name="save" size={13} color="#fff" />
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Salvar e usar</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Botão adicionar nova conexão */}
        {neonConfigs.length > 0 && !showAddNeon && (
          <TouchableOpacity
            onPress={() => setShowAddNeon(true)}
            style={[styles.addConnBtn, { backgroundColor: colors.card, borderColor: colors.primary + "44" }]}
          >
            <Feather name="plus-circle" size={14} color={colors.primary} />
            <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 13 }}>Adicionar nova conexão Neon</Text>
          </TouchableOpacity>
        )}

        {/* Tabelas da conexão selecionada */}
        {neonTables.length > 0 && selectedNeonConfig && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
              {neonTables.map(t => (
                <TouchableOpacity
                  key={t}
                  onPress={() => { setNeonQuery(`SELECT * FROM ${t} LIMIT 100`); }}
                  style={[styles.tableChip, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                >
                  <Feather name="table" size={11} color="#60a5fa" />
                  <Text style={{ color: colors.foreground, fontSize: 12 }}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
        )}

        {/* Botão criar tabelas do app no Neon */}
        {(selectedNeonConfig || neonConnStr) && (
          <View style={[styles.panel, { backgroundColor: "#0a1628", borderColor: "#3b82f633", margin: 10 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <Feather name="layers" size={14} color="#60a5fa" />
              <Text style={{ color: "#e2e8f0", fontWeight: "700", fontSize: 13 }}>Tabelas do DevMobile no Neon</Text>
            </View>
            <Text style={{ color: "#94a3b8", fontSize: 12, marginBottom: 10, lineHeight: 18 }}>
              Cria as tabelas para salvar <Text style={{ color: "#60a5fa" }}>conversas, mensagens, templates, playground e projetos</Text> no PostgreSQL Neon.
            </Text>
            <TouchableOpacity
              onPress={createNeonAppTables}
              disabled={creatingNeonTables}
              style={[styles.btn, { backgroundColor: "#1d4ed8", opacity: creatingNeonTables ? 0.6 : 1 }]}
            >
              {creatingNeonTables
                ? <ActivityIndicator size={14} color="#fff" />
                : <><Feather name="cloud" size={13} color="#fff" /><Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Criar tabelas no Neon</Text></>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Editor de query Neon */}
        {(selectedNeonConfig || neonConnStr) && (
          <>
            <View style={[styles.queryEditor, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <TextInput
                style={[styles.queryInput, { color: colors.foreground, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }]}
                value={neonQuery}
                onChangeText={setNeonQuery}
                placeholder={"SELECT * FROM tarefas LIMIT 100\n-- PostgreSQL / Neon"}
                placeholderTextColor={colors.mutedForeground}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
              <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 8, gap: 8 }}>
                <TouchableOpacity
                  onPress={() => { setNeonQuery(""); setNeonResult(null); }}
                  style={[styles.btnSmall, { backgroundColor: colors.secondary, borderColor: colors.border }]}
                >
                  <Feather name="trash-2" size={13} color={colors.mutedForeground} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => runNeonQuery()}
                  disabled={neonLoading || !neonQuery.trim()}
                  style={[styles.runBtn, { backgroundColor: neonQuery.trim() ? "#1d4ed8" : colors.muted, flex: 1 }]}
                >
                  {neonLoading
                    ? <ActivityIndicator size={14} color="#fff" />
                    : <><Feather name="play" size={13} color="#fff" /><Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Executar SQL</Text></>
                  }
                </TouchableOpacity>
              </View>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
              <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
                {QUICK_NEON.map(q => (
                  <TouchableOpacity
                    key={q.label}
                    onPress={() => { setNeonQuery(q.sql); runNeonQuery(q.sql); }}
                    style={[styles.tableChip, { backgroundColor: colors.card, borderColor: "#3b82f644" }]}
                  >
                    <Text style={{ color: "#60a5fa", fontSize: 11 }}>{q.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            {neonResult && (
              <View style={{ flex: 1, borderTopWidth: 1, borderTopColor: colors.border }}>
                <ResultTable result={neonResult} />
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  // ── Render principal ──────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Tabs LOCAL / NEON */}
      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        {([
          { key: "local" as DbTab, label: "💾 SQLite Local", desc: "Funciona offline · salvo no celular" },
          { key: "neon"  as DbTab, label: "🐘 Neon / Postgres", desc: "Nuvem gratuita · precisa de servidor" },
        ] as { key: DbTab; label: string; desc: string }[]).map(tab => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => { setActiveTab(tab.key); Haptics.selectionAsync(); }}
              style={[styles.tab, {
                backgroundColor: active ? colors.primary + "18" : "transparent",
                borderBottomColor: active ? colors.primary : "transparent",
                borderBottomWidth: 2,
                flex: 1,
              }]}
            >
              <Text style={{ color: active ? colors.primary : colors.mutedForeground, fontWeight: active ? "700" : "400", fontSize: 13 }}>
                {tab.label}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 10, marginTop: 1 }}>{tab.desc}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {activeTab === "local" ? <LocalTab /> : <NeonTab />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Estilos ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    borderBottomWidth: 1,
  },
  tab: {
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  dbHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  iconBtn: { padding: 4 },
  panel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
  },
  connInput: {
    minHeight: 60,
    fontSize: 12,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    justifyContent: "center",
  },
  btnSmall: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 36,
    borderRadius: 8,
  },
  queryEditor: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  queryInput: {
    minHeight: 80,
    maxHeight: 160,
    padding: 10,
    fontSize: 13,
    lineHeight: 20,
  },
  tableChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  dbChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 4,
  },
  connCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  addConnBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
  },
  warnBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 10,
    borderBottomWidth: 1,
  },
  infoBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    margin: 10,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ffffff11",
  },
  tableCell: {
    minWidth: 100,
    maxWidth: 250,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "#ffffff11",
  },
  tableHeader: {
    fontWeight: "700",
    fontSize: 11,
  },
});
