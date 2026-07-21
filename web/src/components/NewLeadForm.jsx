import { useState } from "react";
import { api } from "../api.js";

const EMPTY = { name: "", email: "", company: "", website: "", message: "" };

export function NewLeadForm({ onSubmitted }) {
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.submitLead({ ...form, source: "dashboard-demo" });
      setStatus(
        result.status === "duplicate"
          ? "That email already exists — selected lead updated instead."
          : "Lead submitted — the agent is qualifying it now.",
      );
      setForm(EMPTY);
      onSubmitted?.();
    } catch (err) {
      setStatus(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="new-lead">
      <summary>Simulate an inbound lead</summary>
      <form onSubmit={handleSubmit}>
        <div className="row">
          <input placeholder="Name" value={form.name} onChange={update("name")} />
          <input
            placeholder="Email *"
            type="email"
            required
            value={form.email}
            onChange={update("email")}
          />
        </div>
        <div className="row">
          <input
            placeholder="Company"
            value={form.company}
            onChange={update("company")}
          />
          <input
            placeholder="Website (https://…)"
            value={form.website}
            onChange={update("website")}
          />
        </div>
        <textarea
          placeholder="Message from the lead"
          rows={3}
          value={form.message}
          onChange={update("message")}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Submitting…" : "Submit lead"}
        </button>
        {status && <div className="muted">{status}</div>}
      </form>
    </details>
  );
}
