import { clients, response } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error } = await user.auth.getUser();
  if (error || !actor) return response({ error: 'Sign in required' }, 401);

  for (let offset = 0; ; offset += 500) {
    const { data: records, error: recordsError } = await admin.from('evidence').select('object_path').eq('owner_id', actor.id).range(offset, offset + 499);
    if (recordsError) return response({ error: 'Evidence records could not be listed; account deletion was stopped' }, 502);
    const paths = (records ?? []).map((record) => record.object_path as string);
    for (let start = 0; start < paths.length; start += 100) {
      const { error: storageError } = await admin.storage.from('evidence').remove(paths.slice(start, start + 100));
      if (storageError) return response({ error: 'Private evidence could not be deleted; account deletion was stopped' }, 502);
    }
    if ((records ?? []).length < 500) break;
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(actor.id);
  if (deleteError) return response({ error: 'Account data could not be deleted' }, 500);
  return response({ deleted: true });
});
