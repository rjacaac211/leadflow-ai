import { useState } from "react";
import { api } from "../api.js";

const EMPTY = { name: "", email: "", company: "", website: "", message: "" };

const PRESETS = [
  {
    tier: "hot",
    label: "Hot example",
    data: {
      name: "Morgan Ellis",
      email: "morgan.ellis@brightpathsaas.com",
      company: "BrightPath SaaS",
      website: "https://brightpathsaas.com",
      message:
        "Hi — I'm the Head of RevOps at BrightPath, a B2B SaaS company with about 60 employees and a 14-rep sales team. We're still stitching pipeline forecasts together in spreadsheets every week and it's falling apart ahead of our board meeting next month. We need this fixed before next quarter's planning cycle — can we set up a demo this week?",
    },
  },
  {
    tier: "warm",
    label: "Warm example",
    data: {
      name: "Priya Shah",
      email: "priya.shah@fernwoodconsulting.io",
      company: "Fernwood Consulting",
      website: "https://fernwoodconsulting.io",
      message:
        "Hi, I'm a sales rep at a small software consultancy — we've got around 18 people on staff, so it's a pretty lean team. We use a spreadsheet to track our pipeline and it works okay most of the time, though it can be a bit of a hassle to keep updated. Not in any rush, just started looking at what's out there.",
    },
  },
  {
    tier: "cold",
    label: "Cold example",
    data: {
      name: "Alex Kim",
      email: "alex@tinylaunchhq.com",
      company: "TinyLaunch",
      website: "https://tinylaunchhq.com",
      message:
        "Hi, I do a bit of everything at a small marketing agency — we're around 25 people, and I sometimes help track client deals in a spreadsheet when things get busy. It's not really my main job, but I've noticed it can be easy to lose track of where things stand. No particular timeline, just curious what's out there.",
    },
  },
];

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
        <div className="row presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.tier}
              type="button"
              className={`secondary preset preset-${preset.tier}`}
              onClick={() => setForm(preset.data)}
            >
              {preset.label}
            </button>
          ))}
        </div>
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
