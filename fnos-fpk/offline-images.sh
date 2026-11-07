#!/bin/bash
# 运行镜像离线导入 / 导出工具。
# 用法：
#   有网络的机器：./offline-images.sh export
#   拷贝 qqnas-images.tar.gz 到 NAS 后：./offline-images.sh load
set -euo pipefail

ACTION="${1:-export}"
FILE="${2:-qqnas-images.tar.gz}"
IMAGES=("node:22-alpine" "mlikiowa/napcat-docker:latest")

case "$ACTION" in
  export)
    command -v docker >/dev/null 2>&1 || { echo "需要 Docker"; exit 1; }
    for image in "${IMAGES[@]}"; do
      docker pull "$image"
    done
    docker save "${IMAGES[@]}" | gzip > "$FILE"
    echo "已导出：$FILE"
    ;;
  load)
    command -v docker >/dev/null 2>&1 || { echo "需要 Docker"; exit 1; }
    [ -f "$FILE" ] || { echo "找不到 $FILE"; exit 1; }
    gzip -dc "$FILE" | docker load
    echo "镜像已导入，重新启动应用即可。"
    ;;
  *)
    echo "用法：$0 [export|load] [镜像包路径]"
    exit 1
    ;;
esac
