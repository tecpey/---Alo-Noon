import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const bakery = await prisma.bakery.upsert({
    where: { slug: 'alo-noon-demo' },
    update: {},
    create: {
      name: 'نانوایی آلو نون',
      slug: 'alo-noon-demo',
      products: {
        create: [
          { name: 'سنگک', priceRials: 250_000 },
          { name: 'بربری', priceRials: 180_000 },
        ],
      },
    },
  })

  console.log(`Seeded bakery ${bakery.slug}`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
