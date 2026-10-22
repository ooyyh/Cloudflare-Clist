# CList — 云存储聚合服务

CList 是一个基于 Cloudflare Workers 与 D1 的云存储聚合平台，支持多存储后端统一管理、文件分享与 WebDAV 访问，面向团队或个人的轻量级文件门户场景。

[English](./README.md) | 简体中文

## 目录

- [项目概述](#项目概述)
- [架构与组件](#架构与组件)
- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [数据库迁移](#数据库迁移)
- [开发与构建](#开发与构建)
- [部署](#部署)
- [WebDAV](#webdav)
- [项目结构](#项目结构)
- [安全与最佳实践](#安全与最佳实践)
- [支持与联系](#支持与联系)
- [许可证](#许可证)

## 项目概述

CList 通过统一的 Web 界面管理多个云存储后端，提供上传、预览、分享与访问控制等能力。平台以无服务器方式运行在 Cloudflare 边缘网络上，借助 D1 数据库存储配置与元数据，兼顾部署简洁性与全球可用性。

适用场景：

- 多存储后端统一管理与展示
- 团队文件共享与临时分享
- 通过 WebDAV 接入桌面或移动端

## 架构与组件

- **Cloudflare Workers**：提供 Web 应用与 API 服务
- **Cloudflare D1**：存储配置、会话与分享信息
- **S3 兼容存储**：对接 AWS S3、MinIO、阿里云 OSS、腾讯云 COS 等
- **React Router + Vite**：前端应用构建与路由

## 核心能力

### 文件管理
- 文件上传与下载（支持分块上传）
- 文件预览与代码高亮
- 目录结构管理与快速搜索

### 多存储后端
- 多后端统一管理与切换
- 存储访问参数灵活配置
- 后端类型与名称标识

### 访问控制
- 管理员登录与会话管理
- 访客权限：浏览 / 下载 / 上传可分项控制
- 存储后端可设置公开或私有

### 文件分享
- 生成文件或目录分享链接
- 支持分享有效期与分享令牌

### WebDAV
- 对外提供 WebDAV 访问
- 支持独立 WebDAV 账号或复用管理员账号

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/ooyyh/Cloudflare-Clist.git
cd Cloudflare-Clist
```

### 2. 安装依赖

```bash
npm install
```

### 3. 初始化配置

将示例配置复制为实际配置文件，并根据实际环境修改：

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Windows PowerShell 可使用：

```powershell
Copy-Item .\wrangler.jsonc.example .\wrangler.jsonc
```

## 配置说明

### Wrangler 配置

`wrangler.jsonc` 用于配置 Workers 与 D1。建议从 `wrangler.jsonc.example` 复制后修改。

### 环境变量

以下为默认配置字段（来自 `wrangler.jsonc.example`）：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_USERNAME` | 是 | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | 是 | `changeme` | 管理员密码 |
| `SITE_TITLE` | 否 | `CList` | 站点标题 |
| `SITE_ANNOUNCEMENT` | 否 | `Welcome to CList storage service!` | 站点公告 |
| `CHUNK_SIZE_MB` | 否 | `10` | 上传分块大小（MB） |
| `WEBDAV_ENABLED` | 否 | `false` | 是否启用 WebDAV |
| `WEBDAV_USERNAME` | 否 | `webdav` | WebDAV 用户名 |
| `WEBDAV_PASSWORD` | 否 | `changeme` | WebDAV 密码 |
| `VALUE_FROM_CLOUDFLARE` | 否 | `Hello from Cloudflare` | 示例变量（可选） |

> 建议将敏感字段（如密码）通过 Wrangler Secret 管理，以避免明文配置。

## 数据库迁移

1. 登录 Cloudflare：

```bash
wrangler login
```

2. 创建 D1 数据库：

```bash
wrangler d1 create clist
```

3. 将返回的 `database_id` 更新到 `wrangler.jsonc`：

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "clist",
      "database_id": "your_database_id_here"
    }
  ]
}
```

4. 执行数据库迁移：

```bash
wrangler d1 migrations apply clist
```

## 开发与构建

- 开发模式（热重载）：

```bash
npm run dev
```

- 生产构建：

```bash
npm run build
```

- 本地预览生产构建：

```bash
npm run preview
```

- 类型检查：

```bash
npm run typecheck
```

## 部署

### 一键部署

```bash
npm run deploy
```

### 手动部署

```bash
npm run build
wrangler deploy
```

### GitHub Actions

自动化部署说明请参阅 `GITHUB_WORKFLOW_DEPLOY.md`。

## S3 兼容存储配置说明

在后台「添加存储」选择 **S3 兼容服务**，按目标厂商填写：

| 字段 | 说明 |
| --- | --- |
| Endpoint | 不带桶名的服务端点，如 `https://oss-cn-heyuan.aliyuncs.com`、`https://s3.us-east-1.amazonaws.com`、`https://<accountid>.r2.cloudflarestorage.com` |
| Region | 区域 ID。**阿里云 OSS 必须填地域 ID**（如 `cn-heyuan`），填 `oss-cn-heyuan` 或保持默认 `us-east-1` 会报 `SignatureDoesNotMatch` |
| Bucket | 桶名 |
| AccessKeyId / SecretAccessKey | 对应 AK/SK |

### 访问样式（Virtual-Hosted / Path-Style）

CList 默认使用 **虚拟托管（Virtual-Hosted）** 方式访问——桶名作为子域名（`<bucket>.<endpoint>`）。AWS S3、Cloudflare R2、阿里云 OSS 均要求此方式；阿里云 OSS 不支持 path-style，强行使用会返回 `403 SecondLevelDomainForbidden`。

仅在 **MinIO 等未配置泛域名解析的私有存储** 场景下，于「驱动配置」中开启 **强制使用 Path-Style 访问**，桶名会改放入 URL 路径。

> Endpoint 无需也不应自带桶名子域名；如已写成 `https://<bucket>.oss-...`，虚拟托管会自动识别并避免重复拼接，但仍建议填裸端点。

## WebDAV

### 启用 WebDAV

在 `wrangler.jsonc` 中设置：

```json
{
  "vars": {
    "WEBDAV_ENABLED": "true",
    "WEBDAV_USERNAME": "your_webdav_username",
    "WEBDAV_PASSWORD": "your_webdav_password"
  }
}
```

### 访问地址

- 所有存储根目录：`https://your-domain/dav/0/`
- 指定存储：`https://your-domain/dav/{storage_id}/`

### 客户端连接

- **Windows**：映射网络驱动器
- **macOS**：Finder → 前往 → 连接服务器
- **Linux**：使用 davfs2 或文件管理器
- **移动端**：使用支持 WebDAV 的文件管理 App

## 项目结构

```
├── app/                    # React Router 应用源码
│   ├── components/         # 组件
│   ├── lib/                # 工具库
│   ├── routes/             # 路由
│   └── types/              # 类型定义
├── migrations/             # D1 数据库迁移文件
├── workers/                # Cloudflare Workers 入口
├── package.json            # 脚本与依赖
├── wrangler.jsonc          # Workers 配置
├── vite.config.ts          # 构建配置
└── tsconfig.json           # TypeScript 配置
```

## 安全与最佳实践

- 使用强密码并定期轮换管理员凭据
- 将 WebDAV 与管理员账号分离，降低暴露面
- 仅在需要时开放访客上传与下载权限
- 为分享链接设置有效期，减少长期暴露

## 支持与联系

- GitHub：<https://github.com/ooyyh>
- Email：laowan345@gmail.com

## 许可证

本项目按照仓库中指定的条款进行许可。
