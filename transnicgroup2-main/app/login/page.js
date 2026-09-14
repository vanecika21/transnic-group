"use client";
import React, { useState } from "react";
import { Lock } from "lucide-react";

export default function LoginPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Cod greșit.");
      window.location.href = "/";
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#14171c",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: "#1c2029",
          border: "1px solid #2a303b",
          borderRadius: 14,
          padding: 28,
          width: 300,
          color: "#eae7e0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Lock size={18} color="#f2b705" />
          <div style={{ fontWeight: 700, fontSize: 16 }}>Taxi Fleet Pro</div>
        </div>
        <div style={{ fontSize: 12.5, color: "#8b93a1", marginBottom: 14 }}>
          Introdu codul de acces
        </div>
        <input
          type="password"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Cod acces"
          style={{
            width: "100%",
            background: "#0f1216",
            border: "1px solid #2a303b",
            color: "#eae7e0",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 14,
            marginBottom: 12,
            boxSizing: "border-box",
          }}
        />
        {error && (
          <div style={{ color: "#e5484d", fontSize: 12.5, marginBottom: 10 }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={loading || !code}
          style={{
            width: "100%",
            background: "#f2b705",
            color: "#14171c",
            border: "none",
            borderRadius: 8,
            padding: "10px 12px",
            fontWeight: 700,
            fontSize: 14,
            cursor: loading ? "default" : "pointer",
            opacity: loading || !code ? 0.7 : 1,
          }}
        >
          {loading ? "Se verifică…" : "Intră"}
        </button>
      </form>
    </div>
  );
}
