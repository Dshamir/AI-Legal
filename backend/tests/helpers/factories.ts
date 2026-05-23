import crypto from "crypto";

export function fakeUUID() {
  return crypto.randomUUID();
}

export function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: fakeUUID(),
    userId: fakeUUID(),
    name: "Test Project",
    description: null,
    visibility: "private",
    sharedWith: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}
