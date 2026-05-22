export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  
  const supabaseUrl = env.SUPABASE_URL || 'https://db.lxocykynmkhfxdekmcek.supabase.co';
  const supabaseKey = env.SUPABASE_KEY || '';
  
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/macro_indicators?select=year,value&label=eq.Ceramic%20Tile%20Production&order=year.asc`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
