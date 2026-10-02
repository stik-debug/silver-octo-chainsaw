// DEV/TEST ONLY helper. Inserts service categories (system configuration) and nothing else:
// no users, providers, bookings, payments or reviews are ever seeded. Never run automatically on deploy.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const cats = ["Plumbing","Electrical","Cleaning","Carpentry","Painting","Gardening","Appliance repair","Moving","Mechanic","Hair & beauty"];
(async () => {
  for (const name of cats) {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");
    await db.serviceCategory.upsert({ where: { slug }, update: {}, create: { slug, name } });
  }
})().finally(() => db.$disconnect());
