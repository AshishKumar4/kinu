#!/bin/bash
set -euo pipefail
mkdir -p /source /stage /backups /lower
printf 'publication:publication-test-only:publication-test-only-secret' >/tmp/passwd
chmod 600 /tmp/passwd

s3fs publication /backups -o passwd_file=/tmp/passwd,url=http://publication-minio:9000,use_path_request_style,connect_timeout=10,readwrite_timeout=30,retries=3,multipart_size=5,logfile=/tmp/s3fs.log
head -c 67108864 /dev/urandom >/source/dense.bin
/usr/bin/mksquashfs /source /stage/dense.sqsh -comp zstd -no-progress >/dev/null
date -u '+dense-start=%FT%TZ'
dd if=/stage/dense.sqsh of=/backups/dense.sqsh bs=4M conv=fsync
date -u '+dense-finished=%FT%TZ'
sha256sum /stage/dense.sqsh /backups/dense.sqsh
/usr/local/bin/devbox-squashfuse /backups/dense.sqsh /lower -o ro,allow_other
truncate -s 2147483648 /source/sparse.bin
/usr/bin/mksquashfs /source /stage/sparse.sqsh -comp zstd -no-progress >/dev/null
date -u '+mounted-lower-publication-start=%FT%TZ'
dd if=/stage/sparse.sqsh of=/backups/sparse.sqsh bs=4M conv=fsync
date -u '+mounted-lower-publication-finished=%FT%TZ'
sha256sum /stage/sparse.sqsh /backups/sparse.sqsh
stat -c '%s %n' /stage/*.sqsh
fusermount -u /lower
fusermount -u /backups
cat /tmp/s3fs.log
