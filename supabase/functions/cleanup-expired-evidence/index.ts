import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { response } from '../_shared/common.ts';

const BATCH_SIZE = 100;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('Authorization');
  if (!serviceKey || authorization !== `Bearer ${serviceKey}`) {
    return response({ error: 'Service role required' }, 401);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: expired, error: queryError } = await admin.from('evidence')
    .select('id,object_path')
    .lte('expires_at', Date.now())
    .order('expires_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (queryError) return response({ error: 'Could not load expired evidence' }, 500);
  if (!expired?.length) return response({ deleted: 0, failed: 0, remaining: false });

  const { error: storageError } = await admin.storage.from('evidence')
    .remove(expired.map((record) => record.object_path));
  if (storageError) {
    console.error('Expired evidence storage deletion failed', storageError.message);
    return response({ deleted: 0, failed: expired.length, remaining: true }, 502);
  }

  const { error: metadataError } = await admin.from('evidence')
    .delete()
    .in('id', expired.map((record) => record.id));
  if (metadataError) {
    console.error('Expired evidence metadata deletion failed', metadataError.message);
    return response({ deleted: 0, failed: expired.length, remaining: true }, 500);
  }

  return response({ deleted: expired.length, failed: 0, remaining: expired.length === BATCH_SIZE });
});
