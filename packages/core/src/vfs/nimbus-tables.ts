export function isNimbusTable(name: string): boolean {
  return name.startsWith('vfs_') || name.startsWith('nimbus_');
}
