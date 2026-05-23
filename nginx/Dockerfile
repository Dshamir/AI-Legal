FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
EXPOSE 80
