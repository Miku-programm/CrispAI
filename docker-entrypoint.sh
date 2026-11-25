#!/bin/sh
# 以普通用户运行应用。数据卷可能是旧版本以 root 创建的，所以先用 root 把属主改过来，
# 再降权执行真正的命令；已经不是 root（比如编排平台指定了用户）就直接执行
set -e
if [ "$(id -u)" = "0" ]; then
  upload_dir="${UPLOAD_DIR:-/data/upload}"
  mkdir -p "$upload_dir"
  chown -R bun:bun /data
  # UPLOAD_DIR 被改到 /data 之外时，那个目录同样要交给 bun，否则降权后图片存不进去
  case "$upload_dir" in
    /data|/data/*|/) ;;
    *) chown -R bun:bun "$upload_dir" ;;
  esac
  exec setpriv --reuid=bun --regid=bun --init-groups "$@"
fi
exec "$@"
