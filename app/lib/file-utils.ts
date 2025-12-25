// File type detection utilities

export type FileType = 'video' | 'audio' | 'image' | 'text' | 'code' | 'pdf' | 'unknown';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v', 'flv', 'wmv', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'webm'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
const TEXT_EXTENSIONS = ['txt', 'log', 'md', 'markdown', 'rst', 'csv', 'ini', 'cfg', 'conf'];
const CODE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'scss', 'less',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb',
  'php', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'xml', 'yaml', 'yml', 'toml', 'vue', 'svelte', 'astro',
  'swift', 'kt', 'scala', 'r', 'lua', 'pl', 'ex', 'exs',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'env'
];
const PDF_EXTENSIONS = ['pdf'];

export function getFileExtension(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function getFileType(filename: string): FileType {
  const ext = getFileExtension(filename);

  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (CODE_EXTENSIONS.includes(ext)) return 'code';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';

  return 'unknown';
}

export function isPreviewable(filename: string): boolean {
  const type = getFileType(filename);
  return ['video', 'audio', 'image', 'text', 'code', 'pdf'].includes(type);
}

export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename);

  const mimeTypes: Record<string, string> = {
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    // Image
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    // Code
    js: 'text/javascript',
    ts: 'text/typescript',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css',
    xml: 'text/xml',
    // PDF
    pdf: 'application/pdf',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

export function getCodeLanguage(filename: string): string {
  const ext = getFileExtension(filename);

  const languages: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    bat: 'batch',
    cmd: 'batch',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    markdown: 'markdown',
    vue: 'vue',
    svelte: 'svelte',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    lua: 'lua',
    pl: 'perl',
    ex: 'elixir',
    exs: 'elixir',
  };

  return languages[ext] || 'plaintext';
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
