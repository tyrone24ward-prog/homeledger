const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: corsHeaders },
    );
  }

  try {
    const { username, password } = await request.json();
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const emailByUsername: Record<string, string | undefined> = {
      tdw24: Deno.env.get("HOMELEDGER_TDW24_EMAIL"),
      pcmw7: Deno.env.get("HOMELEDGER_PCMW7_EMAIL"),
    };
    const profileByUsername: Record<string, string> = {
      tdw24: "Tyrone",
      pcmw7: "Pamela",
    };
    const email = emailByUsername[normalizedUsername];
    const projectUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = request.headers.get("apikey");

    if (!email || !password || !projectUrl || !publishableKey) {
      return Response.json(
        { error: "Invalid login" },
        { status: 400, headers: corsHeaders },
      );
    }

    const authResponse = await fetch(
      `${projectUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${publishableKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      },
    );
    const responseBody = await authResponse.json();
    const publicResponse = authResponse.ok
      ? {
          ...responseBody,
          homeledger_profile: profileByUsername[normalizedUsername],
        }
      : responseBody;

    return new Response(JSON.stringify(publicResponse), {
      status: authResponse.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch {
    return Response.json(
      { error: "Invalid login" },
      { status: 400, headers: corsHeaders },
    );
  }
});
