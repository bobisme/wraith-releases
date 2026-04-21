dev:
  bun run dev

build:
  bun run build

deploy: build
  wrangler pages deploy dist/
