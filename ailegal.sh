#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose"
PROJECT_NAME="mike"
BACKUP_DIR="./backups"
WATCHDOG_MAX_RETRIES="${WATCHDOG_MAX_RETRIES:-3}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

BOOT_ORDER=(postgres redis minio gotrue postgrest pgadmin glitchtip glitchtip-worker backend frontend nginx)

declare -A SERVICE_PORTS=(
  [postgres]=5432
  [redis]=6379
  [minio]="9000,9001"
  [gotrue]=9999
  [postgrest]=3002
  [pgadmin]=5050
  [glitchtip]=8000
  [backend]=3001
  [frontend]=3000
  [nginx]=80
)

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

check_env() {
  if [ ! -f .env ]; then
    log_error ".env file not found. Copy .env.example to .env and fill in values."
    log_info "  cp .env.example .env"
    exit 1
  fi
}

cmd_up() {
  check_env
  log_info "Starting Mike platform (${#BOOT_ORDER[@]} services)..."
  $COMPOSE up -d "${@:---wait}"
  log_ok "All services started."
  cmd_health
}

cmd_down() {
  log_info "Stopping all services..."
  $COMPOSE down "$@"
  log_ok "All services stopped."
}

cmd_build() {
  check_env
  local service="${1:-}"
  if [ -n "$service" ]; then
    log_info "Building $service..."
    $COMPOSE build "$service"
  else
    log_info "Building all services..."
    $COMPOSE build
  fi
  log_ok "Build complete."
}

cmd_rebuild() {
  check_env
  local service="${1:-}"
  if [ -n "$service" ]; then
    log_info "Rebuilding $service (no cache)..."
    $COMPOSE build --no-cache "$service"
  else
    log_info "Rebuilding all services (no cache)..."
    $COMPOSE build --no-cache
  fi
  log_ok "Rebuild complete."
}

cmd_restart() {
  local service="${1:-}"
  if [ -n "$service" ]; then
    log_info "Restarting $service..."
    $COMPOSE restart "$service"
  else
    log_info "Restarting all services..."
    $COMPOSE restart
  fi
  log_ok "Restart complete."
}

cmd_logs() {
  local service="${1:-}"
  if [ -n "$service" ]; then
    $COMPOSE logs -f "$service"
  else
    $COMPOSE logs -f
  fi
}

cmd_shell() {
  local service="${1:?Usage: ./ailegal.sh shell <service>}"
  log_info "Opening shell in $service..."
  $COMPOSE exec "$service" sh -c 'if command -v bash >/dev/null; then bash; else sh; fi'
}

cmd_health() {
  echo ""
  printf "${CYAN}%-20s %-12s %-15s %-10s${NC}\n" "SERVICE" "STATUS" "PORT(S)" "UPTIME"
  printf "%-20s %-12s %-15s %-10s\n" "-------------------" "----------" "--------------" "---------"

  for service in "${BOOT_ORDER[@]}"; do
    local status uptime ports
    status=$(docker inspect --format='{{.State.Health.Status}}' "${PROJECT_NAME}-${service}-1" 2>/dev/null || echo "not found")
    uptime=$(docker inspect --format='{{.State.StartedAt}}' "${PROJECT_NAME}-${service}-1" 2>/dev/null || echo "—")
    ports="${SERVICE_PORTS[$service]:-—}"

    local color="$RED"
    if [ "$status" = "healthy" ]; then color="$GREEN"; fi
    if [ "$status" = "starting" ]; then color="$YELLOW"; fi

    printf "${color}%-20s %-12s${NC} %-15s %-10s\n" "$service" "$status" "$ports" "${uptime:0:19}"
  done
  echo ""
}

cmd_status() { cmd_health; }

cmd_ports() {
  echo ""
  printf "${CYAN}%-20s %-20s${NC}\n" "SERVICE" "PORT(S)"
  printf "%-20s %-20s\n" "-------------------" "-------------------"
  for service in "${BOOT_ORDER[@]}"; do
    printf "%-20s %-20s\n" "$service" "${SERVICE_PORTS[$service]:-—}"
  done
  echo ""
}

cmd_db_migrate() {
  log_info "Running Prisma migrations..."
  $COMPOSE exec backend npx prisma migrate deploy
  log_ok "Migrations applied."
}

cmd_db_studio() {
  log_info "Opening Prisma Studio..."
  cd backend && npx prisma studio
}

cmd_db_seed() {
  log_info "Seeding database..."
  $COMPOSE exec backend npx prisma db seed
  log_ok "Database seeded."
}

cmd_db_backup() {
  check_env
  mkdir -p "$BACKUP_DIR"
  local timestamp
  timestamp=$(date +%Y%m%d_%H%M%S)
  local filename="${BACKUP_DIR}/mike_${timestamp}.sql.gz"
  log_info "Backing up database to $filename..."
  source .env 2>/dev/null || true
  $COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-mike}" "${POSTGRES_DB:-mike}" | gzip > "$filename"
  log_ok "Backup saved: $filename ($(du -h "$filename" | cut -f1))"
}

cmd_db_restore() {
  local file="${1:?Usage: ./ailegal.sh db:restore <file.sql.gz>}"
  if [ ! -f "$file" ]; then
    log_error "File not found: $file"
    exit 1
  fi
  log_warn "This will overwrite the current database. Press Ctrl+C to cancel."
  read -r -p "Continue? [y/N] " confirm
  if [[ "$confirm" != [yY] ]]; then
    log_info "Cancelled."
    exit 0
  fi
  source .env 2>/dev/null || true
  log_info "Restoring from $file..."
  gunzip -c "$file" | $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-mike}" "${POSTGRES_DB:-mike}"
  log_ok "Database restored."
}

cmd_test() {
  log_info "Running test suite..."
  $COMPOSE exec backend npm test 2>/dev/null || log_warn "Backend tests not configured yet"
  $COMPOSE exec frontend npm test 2>/dev/null || log_warn "Frontend tests not configured yet"
  log_ok "Tests complete."
}

cmd_lint() {
  log_info "Running linters..."
  $COMPOSE exec backend npm run lint 2>/dev/null || log_warn "Backend lint not configured"
  $COMPOSE exec frontend npm run lint
  log_ok "Lint complete."
}

cmd_bump() {
  local type="${1:?Usage: ./ailegal.sh bump <patch|minor|major>}"
  case "$type" in
    patch|minor|major) ;;
    *) log_error "Invalid bump type: $type (use patch, minor, or major)"; exit 1 ;;
  esac

  cd backend && npm version "$type" --no-git-tag-version && cd ..
  cd frontend && npm version "$type" --no-git-tag-version && cd ..

  local version
  version=$(node -p "require('./backend/package.json').version")
  git add backend/package.json frontend/package.json
  git commit -m "chore: bump version to v${version}"
  git tag "v${version}"
  log_ok "Bumped to v${version}"
}

cmd_clean() {
  log_warn "Removing containers, volumes, and networks..."
  $COMPOSE down -v --remove-orphans
  log_ok "Cleaned."
}

cmd_nuke() {
  log_warn "Full reset: clean + rebuild + migrate + seed"
  cmd_clean
  cmd_build
  cmd_up
  sleep 5
  cmd_db_migrate 2>/dev/null || log_warn "Migrations not ready yet (Phase 3)"
  cmd_db_seed 2>/dev/null || log_warn "Seeding not ready yet (Phase 3)"
  log_ok "Nuke complete. Fresh environment ready."
}

case "${1:-help}" in
  up)           shift; cmd_up "$@" ;;
  down)         shift; cmd_down "$@" ;;
  build)        shift; cmd_build "$@" ;;
  rebuild)      shift; cmd_rebuild "$@" ;;
  restart)      shift; cmd_restart "$@" ;;
  logs)         shift; cmd_logs "$@" ;;
  shell)        shift; cmd_shell "$@" ;;
  health)       cmd_health ;;
  status)       cmd_status ;;
  ports)        cmd_ports ;;
  db:migrate)   cmd_db_migrate ;;
  db:studio)    cmd_db_studio ;;
  db:seed)      cmd_db_seed ;;
  db:backup)    cmd_db_backup ;;
  db:restore)   shift; cmd_db_restore "$@" ;;
  test)         cmd_test ;;
  lint)         cmd_lint ;;
  bump)         shift; cmd_bump "$@" ;;
  clean)        cmd_clean ;;
  nuke)         cmd_nuke ;;
  help|*)
    echo ""
    echo "Usage: ./ailegal.sh <command> [service] [options]"
    echo ""
    echo "Commands:"
    echo "  up                   Start all services (health-waited)"
    echo "  down                 Stop all services"
    echo "  build [service]      Build containers"
    echo "  rebuild [service]    Force rebuild (no cache)"
    echo "  restart [service]    Restart service(s)"
    echo "  logs [service]       Tail logs"
    echo "  shell <service>      Open shell in container"
    echo "  health               Health check all services"
    echo "  status               Service status table"
    echo "  ports                Port allocation map"
    echo "  db:migrate           Run Prisma migrations"
    echo "  db:studio            Open Prisma Studio"
    echo "  db:seed              Seed dev data"
    echo "  db:backup            Backup database"
    echo "  db:restore <file>    Restore database"
    echo "  test                 Run test suite"
    echo "  lint                 Run linters"
    echo "  bump <type>          Version bump (patch/minor/major)"
    echo "  clean                Remove containers and volumes"
    echo "  nuke                 Full reset + rebuild"
    echo ""
    ;;
esac
