import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

const REPLY_PRESETS = [
  {
    key: "interested",
    label: "Interested",
    text: "This sounds like exactly what we need — can we set up a call this week to see a demo? I'd like to loop in our COO too.",
  },
  {
    key: "question",
    label: "Question",
    text: "Before we go further — does this integrate with Salesforce, or does it only work as a standalone tool?",
  },
  {
    key: "optout",
    label: "Opt-out",
    text: "Please stop emailing me — we're not evaluating new tools right now and won't be for a while.",
  },
];

// The pipeline records one `llm_usage` event per graph run (intake, each
// approval resume, each inbound reply), so a lead accumulates several. Summing
// them gives what this lead has cost end to end.
function totalLlmUsage(events) {
  return events.reduce(
    (total, event) => {
      if (event.type !== "llm_usage" || !event.detail) return total;
      return {
        calls: total.calls + (event.detail.calls ?? 0),
        tokens:
          total.tokens + (event.detail.inputTokens ?? 0) + (event.detail.outputTokens ?? 0),
        costUsd: total.costUsd + (event.detail.costUsd ?? 0),
      };
    },
    { calls: 0, tokens: 0, costUsd: 0 },
  );
}

export function LeadDetail({ leadId, onChanged }) {
  const [lead, setLead] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getLead(leadId);
      setLead(data.lead);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [leadId]);

  useEffect(() => {
    setLead(null);
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error) return <div className="banner error">{error}</div>;
  if (!lead) return <div className="placeholder">Loading…</div>;

  const draft = [...lead.messages]
    .reverse()
    .find((m) => m.direction === "OUTBOUND" && m.status === "DRAFT");

  const usage = totalLlmUsage(lead.events);

  return (
    <div className="detail">
      <h2>
        {lead.name} <span className="muted">· {lead.email}</span>
      </h2>
      <div className="facts">
        {lead.company && <span>{lead.company}</span>}
        {lead.companyWebsite && (
          <a href={lead.companyWebsite} target="_blank" rel="noreferrer">
            {lead.companyWebsite}
          </a>
        )}
        {lead.score != null && (
          <span className={`tier tier-${lead.tier}`}>
            {lead.score}/100 · {lead.tier}
          </span>
        )}
        {lead.hubspotContactId && <span>HubSpot #{lead.hubspotContactId}</span>}
        {usage.calls > 0 && (
          <span
            className="cost"
            title={`${usage.calls} Claude calls · ${usage.tokens.toLocaleString()} tokens`}
          >
            ${usage.costUsd.toFixed(4)} agent cost
          </span>
        )}
      </div>

      {lead.qualificationReason && (
        <blockquote className="reason">{lead.qualificationReason}</blockquote>
      )}

      {lead.stage === "AWAITING_APPROVAL" && draft && (
        <ApprovalCard
          leadId={lead.id}
          draft={draft}
          onDecided={() => {
            refresh();
            onChanged?.();
          }}
        />
      )}

      <SimulateReply lead={lead} onSent={refresh} />

      <h3>Messages</h3>
      {lead.messages.length === 0 && <div className="muted">None yet.</div>}
      {lead.messages.map((message) => (
        <div key={message.id} className={`message ${message.direction.toLowerCase()}`}>
          <div className="message-meta">
            {message.direction === "OUTBOUND" ? "→ to lead" : "← from lead"} ·{" "}
            {message.status.toLowerCase()} ·{" "}
            {new Date(message.createdAt).toLocaleString()}
          </div>
          {message.subject && <strong>{message.subject}</strong>}
          <pre>{message.body}</pre>
        </div>
      ))}

      <h3>Timeline</h3>
      <ul className="timeline">
        {lead.events.map((event) => (
          <li key={event.id}>
            <span className="muted">
              {new Date(event.createdAt).toLocaleTimeString()}
            </span>{" "}
            <code>{event.type}</code>
            {event.detail && (
              <details>
                <summary>detail</summary>
                <pre>{JSON.stringify(event.detail, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalCard({ leadId, draft, onDecided }) {
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function decide(action) {
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") {
        await api.approve(leadId, { subject, body });
      } else {
        await api.reject(leadId, "rejected from dashboard");
      }
      onDecided();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval">
      <h3>Outreach draft — awaiting your approval</h3>
      <p className="muted">
        Edit freely; approving sends exactly what is shown below.
      </p>
      <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button disabled={busy} onClick={() => decide("approve")}>
          {busy ? "Working…" : "Approve & send"}
        </button>
        <button className="secondary" disabled={busy} onClick={() => decide("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

function SimulateReply({ lead, onSent }) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!["OUTREACH_SENT", "REPLIED", "ESCALATED"].includes(lead.stage)) return null;

  async function send(event) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const result = await api.simulateReply(lead.email, message);
      setStatus(`Classified as "${result.intent}".`);
      setMessage("");
      onSent();
    } catch (err) {
      setStatus(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="new-lead">
      <summary>Simulate a reply from this lead</summary>
      <form onSubmit={send}>
        <div className="row presets">
          {REPLY_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="secondary preset"
              onClick={() => setMessage(preset.text)}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <textarea
          rows={3}
          required
          placeholder='e.g. "Sounds interesting — can we book a demo next week?"'
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send reply"}
        </button>
        {status && <div className="muted">{status}</div>}
      </form>
    </details>
  );
}
