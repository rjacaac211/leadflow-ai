async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

export const api = {
  listLeads: () => request("/api/leads"),
  getLead: (id) => request(`/api/leads/${id}`),
  approve: (id, edits) =>
    request(`/api/leads/${id}/approve`, {
      method: "POST",
      body: JSON.stringify(edits),
    }),
  reject: (id, reason) =>
    request(`/api/leads/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  submitLead: (lead) =>
    request("/api/webhooks/lead", { method: "POST", body: JSON.stringify(lead) }),
  simulateReply: (email, message) =>
    request("/api/webhooks/email-reply", {
      method: "POST",
      body: JSON.stringify({ email, message }),
    }),
};
