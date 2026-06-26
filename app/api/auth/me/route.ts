// GET /api/auth/me — identità della sessione corrente.
//
// Sostituisce getSessionRole() (oggi supabase.auth.getUser().app_metadata.role).
// getClaims(req) legge il cookie tn_at (o Authorization: Bearer, per test/curl), verifica
// firma+scadenza server-side ed estrae i Claims. Ritorna:
//   { sub, role }   role = 'cassa'|'regia'|'admin' per lo staff, null per l'ospite.
//   401             se manca/è invalido/è scaduto l'access token.
//
// NON tenta il refresh qui: /me è una lettura pura, idempotente, senza side-effect. Il
// refresh sliding (rinnova tn_at via tn_rt quando l'access scade) è responsabilità del
// middleware — vedi Fase 3.3 del piano.
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { getClaims } from '@/lib/auth-server/guard';
import { isStaffClaims } from '@/lib/auth-server/claims';
import { errorJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const claims = await getClaims(req);
  if (!claims) return errorJson(401, 'unauthenticated');

  // role assente = ospite anonimo (app_role()='guest' lato DB).
  const role = isStaffClaims(claims) ? claims.app_metadata.role : null;

  return NextResponse.json({ sub: claims.sub, role });
}
