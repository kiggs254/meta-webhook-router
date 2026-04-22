import { sequelize, Tenant, Registration } from '../models/index.js';

async function main() {
  await sequelize.authenticate();
  await sequelize.sync();

  const tenants = await Tenant.findAll({ order: [['id', 'ASC']] });
  const regs = await Registration.findAll();

  const byTenant = new Map<string, Registration[]>();
  regs.forEach((r) => {
    const arr = byTenant.get(r.tenant_id) || [];
    arr.push(r);
    byTenant.set(r.tenant_id, arr);
  });

  // eslint-disable-next-line no-console
  console.log(`\n${tenants.length} tenant(s):\n`);
  for (const t of tenants) {
    const rs = byTenant.get(t.id) || [];
    // eslint-disable-next-line no-console
    console.log(`  [${t.enabled ? '•' : ' '}] ${t.id}  "${t.name}"  — ${rs.length} registration(s)`);
    for (const r of rs) {
      // eslint-disable-next-line no-console
      console.log(`        ${r.waba_id} -> ${r.forward_url}${r.enabled ? '' : ' (disabled)'}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log('');

  await sequelize.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed:', err);
  process.exit(1);
});
