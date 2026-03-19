const LINEAR_API_URL = "https://api.linear.app/graphql";

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
};

type LinearIssuesPayload = {
  errors?: Array<{ message?: string }>;
  data?: {
    issues?: {
      nodes?: Array<{
        id: string;
        identifier: string;
        title: string;
        description?: string | null;
        url?: string | null;
        state?: { name?: string | null } | null;
      }>;
    };
  };
};

async function queryLinearIssues(query: string, variables?: Record<string, unknown>) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set");
  }

  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as LinearIssuesPayload;

  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "Linear GraphQL request failed");
  }

  return payload.data?.issues?.nodes ?? [];
}

function mapLinearIssue(node: {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state?: { name?: string | null } | null;
}): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? "",
    state: node.state?.name ?? "Unknown",
    url: node.url ?? "",
  };
}

// Fetch a small set of fields directly from Linear. The MVP does not cache anything.
export async function fetchLinearIssues(): Promise<LinearIssue[]> {
  const teamKey = process.env.LINEAR_TEAM_KEY?.trim();

  const query = teamKey
    ? `
      query PhoebeIssues($teamKey: String!) {
        issues(first: 100, filter: { team: { key: { eq: $teamKey } } }) {
          nodes { id identifier title description url state { name } }
        }
      }
    `
    : `
      query PhoebeIssues {
        issues(first: 100) {
          nodes { id identifier title description url state { name } }
        }
      }
    `;

  const variables = teamKey ? { teamKey } : undefined;
  const nodes = await queryLinearIssues(query, variables);
  return nodes.map(mapLinearIssue);
}

export async function fetchLinearIssueByTicketId(ticketId: string): Promise<LinearIssue> {
  const issues = await fetchLinearIssues();
  const match = issues.find(
    (issue) => issue.identifier === ticketId || issue.id === ticketId,
  );

  if (!match) {
    throw new Error(`Linear issue ${ticketId} not found`);
  }

  return match;
}
