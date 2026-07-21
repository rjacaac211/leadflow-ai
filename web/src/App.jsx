import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { LeadDetail } from "./components/LeadDetail.jsx";
import { NewLeadForm } from "./components/NewLeadForm.jsx";

const STAGE_LABELS = {
  NEW: "New",
  QUALIFIED: "Qualified",
  DISQUALIFIED: "Disqualified",
  AWAITING_APPROVAL: "Needs approval",
  OUTREACH_SENT: "Outreach sent",
  REPLIED: "Replied",
  ESCALATED: "Escalated",
  OPTED_OUT: "Opted out",
};

export default function App() {
  const [leads, setLeads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listLeads();
      setLeads(data.leads);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const pendingCount = leads.filter((l) => l.stage === "AWAITING_APPROVAL").length;

  return (
    <div className="layout">
      <header className="topbar">
        <h1>
          LeadFlow <span className="accent">AI</span>
        </h1>
        <span className="subtitle">
          autonomous lead qualification &amp; outreach
          {pendingCount > 0 && (
            <span className="pending-pill">{pendingCount} awaiting approval</span>
          )}
        </span>
      </header>

      {error && <div className="banner error">API error: {error}</div>}

      <main className="columns">
        <section className="pane">
          <NewLeadForm onSubmitted={refresh} />
          <h2>Pipeline</h2>
          <table className="lead-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Company</th>
                <th>Score</th>
                <th>Stage</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={lead.id === selectedId ? "selected" : ""}
                  onClick={() => setSelectedId(lead.id)}
                >
                  <td>
                    <strong>{lead.name}</strong>
                    <div className="muted">{lead.email}</div>
                  </td>
                  <td>{lead.company || "—"}</td>
                  <td>
                    {lead.score != null ? (
                      <span className={`tier tier-${lead.tier}`}>
                        {lead.score} {lead.tier}
                      </span>
                    ) : (
                      <span className="muted">…</span>
                    )}
                  </td>
                  <td>
                    <span className={`stage stage-${lead.stage}`}>
                      {STAGE_LABELS[lead.stage] ?? lead.stage}
                    </span>
                  </td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan="4" className="muted empty">
                    No leads yet — submit one above or POST to /api/webhooks/lead.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="pane">
          {selectedId ? (
            <LeadDetail leadId={selectedId} onChanged={refresh} />
          ) : (
            <div className="placeholder">Select a lead to see its timeline.</div>
          )}
        </section>
      </main>
    </div>
  );
}
