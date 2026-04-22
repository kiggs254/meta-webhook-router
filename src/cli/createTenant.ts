import { sequelize, Tenant } from '../models/index.js';
import { randomHexSecret } from '../utils/hmac.js';

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const id = (arg('id') || '').trim();
  const name = (arg('name') || id).trim();
  const regenerate = process.argv.includes('--regenerate');

  if (!id) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run tenant:create -- --id <id> [--name "Human Readable"] [--regenerate]');
    process.exit(1);
  }

  await sequelize.authenticate();
  await sequelize.sync();

  const existing = await Tenant.findByPk(id);
  if (existing && !regenerate) {
    // eslint-disable-next-line no-console
    console.error(`Tenant "${id}" already exists. Pass --regenerate to rotate the secret.`);
    process.exit(1);
  }

  const secret = randomHexSecret(32);

  if (existing) {
    await existing.update({ name, shared_secret: secret, enabled: true });
  } else {
    await Tenant.create({ id, name, shared_secret: secret, enabled: true });
  }

  // eslint-disable-next-line no-console
  console.log('\nTenant provisioned — copy the secret, it is only shown once:\n');
  // eslint-disable-next-line no-console
  console.log(`  WEBHOOK_ROUTER_TENANT_ID=${id}`);
  // eslint-disable-next-line no-console
  console.log(`  WEBHOOK_ROUTER_TENANT_SECRET=${secret}\n`);

  await sequelize.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to create tenant:', err);
  process.exit(1);
});
