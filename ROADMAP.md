# Roadmap

## Completed

- [x] Self-hosted Docker infrastructure (11 services)
- [x] Backend hardening (validation, error handling, logging)
- [x] Prisma ORM migration with soft-delete and audit trail
- [x] Frontend route protection and accessibility baseline
- [x] CI/CD pipeline with GitHub Actions
- [x] Redis caching infrastructure and key rotation

## Next Priorities

- [ ] Apply Redis caching to project/document list endpoints
- [ ] Fix N+1 project listing queries with Prisma `_count`
- [ ] E2E tests with Playwright
- [ ] MinIO lifecycle policies for storage cleanup
- [ ] Prometheus + Grafana monitoring stack
- [ ] Ngrok integration for external access
- [ ] API versioning (`/api/v1/` prefix)
- [ ] WebSocket support for real-time chat streaming
- [ ] Rate limiting per-user (not just per-IP)
- [ ] Multi-tenant support
- [ ] WCAG 2.1 AA accessibility audit with axe-core
