# MAGI 后端 API

生产源为 `https://magi.lanthan.cn`。以下路径含完整的 `/api` 前缀。正文使用 `application/json`，字符编码为 UTF-8。所有时间采用 UTC ISO 8601，问题 ID 为大写 ULID。示例中的令牌、密钥对和签名来自一次性本地测试数据。

## 通用约定

- 浏览器使用同源 `fetch` 并保留 cookie。非 GET 请求的 `Origin` 必须精确等于 `https://<RP_ID>`。除注册和登录的四个 POST 接口外，全部 API 需要有效会话。过期返回 `401 UNAUTHENTICATED`。API 响应使用 `Cache-Control: no-store`。
- 会话 cookie 为 `magi_sid`，临时挑战 cookie 为 `magi_register` 或 `magi_login`。均设置 `HttpOnly; Secure; SameSite=Strict; Path=/`。前端只负责提交浏览器返回的 WebAuthn JSON。每个认证接口默认按客户端 IP 每分钟限 10 次。
- JSON 字段名区分大小写，业务请求拒绝未定义字段。请求体上限为 256 KiB。`question` 和 `core_reason` 必须有内容。`background`、`goals` 可为空字符串。`confidence` 为 50 到 100 的整数。所有受字数限制的投票文本按 Unicode 码点计数，超长会截断，末字为 `…`。
- 投票方顺序为 `user`（我）、`gpt`（GPT）、`deepseek`（DeepSeek）。答案枚举为 `是` 或 `否`。风险类别可选财务、时间、健康、关系、职业、法律、机会成本、信息不足、其他，严重度可选致命、高、中、低。

## 注册、登录与凭证

### POST /api/auth/register/options

先在 Mac 本机运行 `npm run invite`。可用 `npm run invite -- --ip 192.0.2.10` 将本次注册限定到一个客户端 IP。服务在生成挑战和验证 Passkey 时检查来源。从生成邀请起须在 5 分钟内完成注册，成功后链接立即作废。`deviceName` 去除首尾空白后为 1–120 个 UTF-16 代码单元。响应原样交给 `startRegistration({ optionsJSON })`，同时保留服务器设置的挑战 cookie。已有凭证会出现在 `excludeCredentials`。

请求正文

```json
{
  "inviteToken": "nOA7xAG63z1gr1VjWalAri-aXcOwkmC79KrdzKJ33b0",
  "deviceName": "我的 iPhone"
}
```

成功响应 `200`

```json
{
  "challenge": "-pfL2RWRkIVdGTDejbt7hAeUE2uQYLVMLUJaS_CUnJQ",
  "rp": {
    "name": "MAGI",
    "id": "magi.lanthan.cn"
  },
  "user": {
    "id": "l5gkK8n0Om9NM0DqKXSvNW0VLBerzt4a7rBKHvPB27w",
    "name": "MAGI",
    "displayName": "MAGI"
  },
  "pubKeyCredParams": [
    {
      "alg": -7,
      "type": "public-key"
    },
    {
      "alg": -257,
      "type": "public-key"
    }
  ],
  "timeout": 300000,
  "attestation": "none",
  "excludeCredentials": [],
  "authenticatorSelection": {
    "residentKey": "required",
    "userVerification": "required",
    "requireResidentKey": true
  },
  "extensions": {
    "credProps": true
  },
  "hints": []
}
```

### POST /api/auth/register/verify

提交同一邀请和浏览器创建的凭证。校验成功后设备可登录。挑战有效期 5 分钟，每个挑战只验证一次。遇到 `INVALID_CHALLENGE` 应重新获取选项。

请求正文

```json
{
  "inviteToken": "nOA7xAG63z1gr1VjWalAri-aXcOwkmC79KrdzKJ33b0",
  "response": {
    "id": "43d3x2Cz4raXqWnj7yzSAjjBxOrPQdTSB7zGmZYTF6k",
    "rawId": "43d3x2Cz4raXqWnj7yzSAjjBxOrPQdTSB7zGmZYTF6k",
    "type": "public-key",
    "clientExtensionResults": {},
    "response": {
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiLXBmTDJSV1JrSVZkR1REZWpidDdoQWVVRTJ1UVlMVk1MVUphU19DVW5KUSIsIm9yaWdpbiI6Imh0dHBzOi8vbWFnaS5sYW50aGFuLmNuIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
      "attestationObject": "o2NmbXRkbm9uZWhhdXRoRGF0YVikPObwUPsi7LoiTrTeBvPmDT58kKm1-YrTSYk8xKuEhA9FAAAAAAAAAAAAAAAAAAAAAAAAAAAAION3d8dgs-K2l6lp4-8s0gI4wcTqz0HU0ge8xpmWExeppQECAyYgASFYIA1tlDr5w0SlczfGS_MO7lTV3A471WEsRojSEiq30d9kIlggafCEMgGAuzTDRPMSUd-W_asUiKe7tNVs6xgPrUcpqpRnYXR0U3RtdKA",
      "transports": [
        "internal"
      ]
    }
  }
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### POST /api/auth/login/options

可发现凭证登录，`allowCredentials` 为空数组。响应原样交给 `startAuthentication({ optionsJSON })`。

请求正文

```json
{}
```

成功响应 `200`

```json
{
  "rpId": "magi.lanthan.cn",
  "challenge": "6chKlGwCM-yOSmkHZdXoRCyCIP0zSHUstNpul_DuQRo",
  "allowCredentials": [],
  "timeout": 300000,
  "userVerification": "required"
}
```

### POST /api/auth/login/verify

提交浏览器签名结果，响应通过 `Set-Cookie` 写入 `magi_sid`。同一浏览器已有会话时替换旧会话。会话默认在本次登录成功后 24 小时到期（`Max-Age=86400`），到期后需再次用 Passkey 登录。

请求正文

```json
{
  "response": {
    "id": "43d3x2Cz4raXqWnj7yzSAjjBxOrPQdTSB7zGmZYTF6k",
    "rawId": "43d3x2Cz4raXqWnj7yzSAjjBxOrPQdTSB7zGmZYTF6k",
    "type": "public-key",
    "clientExtensionResults": {},
    "response": {
      "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiNmNoS2xHd0NNLXlPU21rSFpkWG9SQ3lDSVAwelNIVXN0TnB1bF9EdVFSbyIsIm9yaWdpbiI6Imh0dHBzOi8vbWFnaS5sYW50aGFuLmNuIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
      "authenticatorData": "PObwUPsi7LoiTrTeBvPmDT58kKm1-YrTSYk8xKuEhA8FAAAAAQ",
      "signature": "MEUCIC5UdGQ8Peyvce32b5DOvANCqkBHsj94nY5pDBns9uMXAiEAklrkxh3D0b0CDZBOWWHQ6M06pgXTrI0kiF5Ak2kpB6Y",
      "userHandle": "l5gkK8n0Om9NM0DqKXSvNW0VLBerzt4a7rBKHvPB27w"
    }
  }
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### POST /api/auth/logout

撤销当前会话并清除浏览器 cookie。

请求无正文。

成功响应 `200`

```json
{
  "ok": true
}
```

### GET /api/auth/me

请求无正文。

成功响应 `200`

```json
{
  "authenticated": true,
  "credentialsCount": 1
}
```

### GET /api/auth/credentials

结果按注册时间、ID 排序。新凭证的 `lastUsedAt` 为 `null`。

请求无正文。

成功响应 `200`

```json
[
  {
    "id": "43d3x2Cz4raXqWnj7yzSAjjBxOrPQdTSB7zGmZYTF6k",
    "deviceName": "我的 iPhone",
    "createdAt": "2026-11-18T13:40:00.000Z",
    "lastUsedAt": "2026-11-18T13:45:00.000Z"
  }
]
```

### PATCH /api/auth/credentials/:id

路径中的 `id` 是凭证 ID，与问题 ULID 属于不同的字段。名称规则同注册选项。

请求正文

```json
{
  "deviceName": "工作手机"
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### DELETE /api/auth/credentials/:id

删除最后一个凭证会返回 `409 LAST_CREDENTIAL`。成功删除其他凭证时，服务撤销全部会话，前端应跳转登录。

请求无正文。

成功响应 `200`

```json
{
  "ok": true
}
```

## 设置

设置页沿用 `GET /api/auth/credentials`、`PATCH /api/auth/credentials/:id` 和 `DELETE /api/auth/credentials/:id` 管理 Passkey。以下模型接口共用同一个登录会话，写请求按通用约定检查 `Origin`。

### GET /api/settings/models

返回下一轮表决将使用的设置。这个请求只读取 Mac 的 SQLite，即使供应商目录暂时不可用也能返回。

```json
{
  "gpt": { "model": "gpt-6.2-astra", "effort": "max" },
  "deepseek": { "model": "deepseek-v4-pro", "effort": "max" }
}
```

### GET /api/settings/models/options

返回两个供应商各自的模型和思考档位。模型下拉框显示 `label`，保存时提交 `id`。思考强度下拉框使用所选模型的 `efforts`。下例为目录中的两项。

```json
{
  "gpt": { "available": true, "models": [
    { "id": "gpt-6.2-astra", "label": "GPT-6.2-Astra", "efforts": ["low", "medium", "high", "xhigh", "max"] }
  ] },
  "deepseek": { "available": true, "models": [
    { "id": "deepseek-flash", "label": "DeepSeek-V4.1-Flash", "efforts": ["none", "low", "high", "max"] }
  ] }
}
```

套餐模式读取当前 ChatGPT 账号对应用可见的模型。API Key 模式从密钥可见的目录中筛选支持 MAGI 请求格式的已知模型。DeepSeek 的 `none` 表示关闭思考。某一方查询失败时，该方返回 `{"available":false,"models":[]}`，另一方仍可选择。当前设置由前一个接口提供。[OpenAI 套餐模型目录](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [Responses 推理参数](https://developers.openai.com/api/docs/guides/reasoning) · [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)

### PATCH /api/settings/models

提交发生变更的供应商。每个供应商同时提供 `model` 和 `effort`，可以一次提交两家。

```json
{ "deepseek": { "model": "deepseek-flash", "effort": "low" } }
```

成功返回 `200` 和两家完整设置，格式同 `GET /api/settings/models`。两家变更在同一事务中保存。字段错误或模型与档位不匹配返回 `422 INVALID_INPUT`，无法验证变更所需的供应商目录时返回 `503 MODEL_CATALOG_UNAVAILABLE`。

新表决在提交时记录两家选择，自动重试和中断恢复沿用这一轮的选择。双缺席后手动发起的技术重试读取此时最新设置。保存到 SQLite 的选择在 Mac 重新启动后继续生效。

## 问题与表决

已登录的客户端可用 `GET /api/providers/gpt` 查询 GPT 的计费方式。响应包含 `mode`（`api_key` 或 `chatgpt_plan`）和当前生效的 `model`。套餐模式还会返回 `authorized`，表示本机保存了可续期的套餐授权。此接口只读，实际可用额度以 ChatGPT 返回为准。

### POST /api/questions/lint

只检查 `background` 的配置词表。一个词在同一段背景中最多返回一次，命中项按词表顺序排列。

请求正文

```json
{
  "question": "是否在本月订阅这项服务？",
  "background": "我觉得每月 30 元可以接受。",
  "goals": "月度预算不超过 50 元。"
}
```

成功响应 `200`

```json
{
  "warnings": [
    {
      "field": "background",
      "phrase": "我觉得"
    }
  ]
}
```

### POST /api/questions

输入模板的“需要联网”开关对应可选布尔字段 `needsWeb`，每道新题和追问默认 `false`。涉及最新事实时，在提交前设为 `true`，两家模型会各自检索。提交后开关锁定。相同材料仍按原规则去重。预检 `POST /api/questions/lint` 也接受这个字段。

每张有效票包含 `sources`，每项由网页地址 `url` 和该网页影响判断的具体论点 `claim` 组成，最多八项，论点最多 300 字。个人票可以省略 `sources`，默认为 `[]`，其内容只保存在 MAGI。离线模型票返回 `[]`。联网模型票至少包含一项来源，后端将每个网址与该模型本次联网返回的网页逐项核对。

`question`、`background`、`goals`、`reversibility`、`userVote` 必填。`reversibility` 可选 `可逆` 或 `不可逆`。用户票至少包含 `vote`、`confidence`、`core_reason`。省略 `conditions`、`risks`、`flip_condition` 时分别得到 `[]`、`[]`、`""`。投否时前提条件必须为空，风险最多三条。核心理由最多 50 字，每项风险描述和检查动作各最多 40 字。

请求正文

```json
{
  "question": "是否在本月订阅这项服务？",
  "background": "月费为 30 元，可在下个月取消。",
  "goals": "月度预算不超过 50 元。",
  "reversibility": "可逆",
  "needsWeb": false,
  "parentId": null,
  "newInfo": null,
  "acknowledgeWarnings": false,
  "userVote": {
    "vote": "是",
    "confidence": 65,
    "core_reason": "月费在预算内。",
    "conditions": [],
    "risks": [
      {
        "category": "财务",
        "risk": "可能有额外手续费。",
        "check": "核对账单的费用明细。",
        "severity": "中"
      }
    ],
    "flip_condition": "总费用超过预算时改票。",
    "sources": []
  }
}
```

成功响应 `201`

```json
{
  "id": "01M7QFA3R0JQ8GTM3J2HF69S0P",
  "status": "running"
}
```

带新信息追问时，将 `parentId` 设为已决定问题的 ID，并提供至少十个 Unicode 字符的 `newInfo`。新问题仍需提交完整问题、背景、目标、可逆性和自己的票。首次提问省略这两个字段或传 `null`。两次提交的问题材料完全相同，即使更换用户票，也会得到 `409 DUPLICATE_QUESTION` 和已有 ID，前端可以直接打开该详情。

命中倾向词且未设置 `acknowledgeWarnings: true` 时返回 `422`。此时尚未创建问题，也未调用模型。用户确认后重新提交原请求并把该字段置为 `true`。

```json
{
  "error": {
    "code": "LINT_WARNINGS",
    "message": "请确认背景中的倾向性措辞。"
  },
  "warnings": [
    {
      "field": "background",
      "phrase": "我觉得"
    }
  ]
}
```

```json
{
  "error": {
    "code": "DUPLICATE_QUESTION",
    "message": "这组问题材料已经提交。"
  },
  "existingId": "01M7QFA3R0JQ8GTM3J2HF69S0P"
}
```

### GET /api/questions

请求无正文。首次可用 `/api/questions?limit=20`，下一页使用返回的 `nextCursor`，例如 `/api/questions?limit=20&cursor=01M7QFA3R0JQ8GTM3J2HF69S0P`。`limit` 默认 20，范围 1–100。按 ULID 降序，游标本身不包含在下一页。最后一页或空列表的 `nextCursor` 为 `null`。

```json
{
  "items": [
    {
      "id": "01M7QFA3R0JQ8GTM3J2HF69S0P",
      "question": "是否在本月订阅这项服务？",
      "reversibility": "可逆",
      "status": "decided",
      "createdAt": "2026-11-18T14:00:00.000Z",
      "decidedAt": "2026-11-18T14:01:42.410Z",
      "parentId": null,
      "finalDecision": "是"
    }
  ],
  "nextCursor": null
}
```

### GET /api/questions/:id

详情通过 `needsWeb` 回显本题的联网开关。揭晓时，可按每张模型票的 `sources` 展示论点和对应的可点击网页。例如，一条来源可以是 `{"url":"https://example.org/notice","claim":"公告将优惠截止日列为本月最后一天。"}`。

`result.sourceOverlap` 比较两张有效模型票实际引用的网站。按公共后缀表识别可注册域名，同站的不同页面和子域只计一次，独立托管站点分别计算。两家共同引用两个网站、合计使用三个网站时，`score` 为 2/3。

```json
{
  "sharedSites": ["bbc.co.uk", "esa.int"],
  "totalSites": 3,
  "score": 0.6666666666666666,
  "warning": "两方信源重叠，独立性低"
}
```

共同网站数除以两家的网站总数（去重）达到 2/3 时显示上述标记，低于阈值时 `warning` 为 `null`。离线、历史旧题或有模型缺席时，`sourceOverlap` 为 `null`。独立性提示不参与计票。模型本轮没有可核对的网页或引用未能匹配时，沿用一次技术重试，两次均失败则该票以 `WEB_SOURCES_UNVERIFIED` 缺席。

请求无正文。运行中每 3 秒轮询一次。无论哪个模型先完成，`result` 始终为 `null`，两张模型票只包含 `voter` 和 `state: "pending"`。个人票已经锁定，可以立即显示。揭晓后，有效票和缺席票另含 `model`，即该票实际使用的模型名：取自供应商响应，取不到时为配置值；技术重试后重新记录。下例为完整的已决定响应。

```json
{
  "id": "01M7QFA3R0JQ8GTM3J2HF69S0P",
  "status": "decided",
  "question": "是否在本月订阅这项服务？",
  "needsWeb": false,
  "background": "月费为 30 元，可在下个月取消。",
  "goals": "月度预算不超过 50 元。",
  "reversibility": "可逆",
  "parentId": null,
  "newInfo": null,
  "createdAt": "2026-11-18T14:00:00.000Z",
  "decidedAt": "2026-11-18T14:01:42.410Z",
  "nextStatus": null,
  "votes": [
    {
      "voter": "user",
      "state": "valid",
      "vote": "是",
      "confidence": 65,
      "core_reason": "月费在预算内。",
      "conditions": [],
      "risks": [
        {
          "category": "财务",
          "risk": "可能有额外手续费。",
          "check": "核对账单的费用明细。",
          "severity": "中"
        }
      ],
      "flip_condition": "总费用超过预算时改票。",
      "sources": []
    },
    {
      "voter": "gpt",
      "state": "valid",
      "vote": "是",
      "confidence": 72,
      "core_reason": "可取消且费用可控。",
      "conditions": [
        "先确认取消期限。"
      ],
      "risks": [
        {
          "category": "财务",
          "risk": "优惠期满可能涨价。",
          "check": "查阅续订价格。",
          "severity": "高"
        }
      ],
      "flip_condition": "发现长期合同时改票。",
      "sources": [],
      "model": "gpt-6.2-astra"
    },
    {
      "voter": "deepseek",
      "state": "absent",
      "error": "TIMEOUT",
      "model": "deepseek-v4-pro"
    }
  ],
  "result": {
    "sourceOverlap": null,
    "tally": {
      "yes": 2,
      "no": 0,
      "absent": [
        "deepseek"
      ],
      "label": "2:0（DeepSeek 缺席）",
      "userInMinority": false,
      "dissenters": []
    },
    "conclusion": "是",
    "finalDecision": "是",
    "finalReason": null,
    "finalNote": null,
    "conditions": [
      {
        "voter": "gpt",
        "text": "先确认取消期限。"
      }
    ],
    "risks": [
      {
        "id": "gpt-0",
        "voter": "gpt",
        "category": "财务",
        "risk": "优惠期满可能涨价。",
        "check": "查阅续订价格。",
        "severity": "高",
        "categoryMentions": 2,
        "mentionLabel": "两方提到此类",
        "fromDissent": false,
        "visible": true,
        "checkDone": false
      },
      {
        "id": "user-0",
        "voter": "user",
        "category": "财务",
        "risk": "可能有额外手续费。",
        "check": "核对账单的费用明细。",
        "severity": "中",
        "categoryMentions": 2,
        "mentionLabel": "两方提到此类",
        "fromDissent": false,
        "visible": true,
        "checkDone": false
      }
    ],
    "pausedBy": []
  },
  "outcome": null
}
```

- `conclusion` 为计票可直接得出的结论。在需要本人确认或双缺席时为 `null`。`finalDecision` 在进入 `decided` 时写入。本人确认后可通过 `finalReason` 和 `finalNote` 读取选择的原因及备注。
- `tally.yes`、`tally.no` 表示实际是／否票数，`label` 的比例按多票数在前。`dissenters` 仅包含严格少数派，平票时为空。一个模型缺席、剩下的模型与我意见不同时进入 `needs_confirmation`。
- 风险按严重度、提到同类风险的投票方数、投票方顺序排序。同一分类中每项保留独立 ID 和原文，前端可按 `category` 分组。`visible` 标记默认可见的前五条，停机检查必须允许操作全部致命风险，包括折叠项。
- `paused` 时 `nextStatus` 是解除后的目标，`pausedBy` 列出本次触发停机的全部致命风险 ID。每项的 `checkDone` 反映完成情况。其他状态的 `nextStatus` 是 `null`，`pausedBy` 为空数组。`failed` 时也有计票与缺席原因。
- `outcome` 在尚未记录时为 `null`。已记录的结构为 `{"correctAnswer":"是","note":"已核对账单","recordedAt":"2026-11-20T14:00:00.000Z"}`。

| 状态 | 前端可执行的操作 |
|---|---|
| `running` | 轮询 |
| `paused` | 检查风险，完成全部致命项后重新读取 |
| `needs_confirmation` | 提交最终答案和原因 |
| `decided` | 记录或更新事后结果，用新增信息发起新表决 |
| `failed` | 双缺席时手动技术重试 |

### POST /api/questions/:id/confirm

只接受 `needs_confirmation`。`keep_mine` 的最终答案须与个人票一致，`adopt_majority` 须为相反答案。只有一张模型票而双方打平时，`adopt_majority` 表示采纳该模型。`note` 可省略。成功后读取详情即可显示 `decided`。

请求正文

```json
{
  "final": "否",
  "reason": "adopt_majority",
  "note": "我重新核算了续订价格。"
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### POST /api/questions/:id/checks/:riskId

例如 `/api/questions/01M7QFA3R0JQ8GTM3J2HF69S0P/checks/gpt-0`。风险 ID 取自详情中 `result.risks[].id`。计票后可标记任何存在的检查项，重复标记幂等。最后一条致命检查会在同一事务内解除停机，重新 GET 详情查看状态。

请求正文

```json
{
  "done": true
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### POST /api/questions/:id/retry-absent

仅在 `failed` 时受理，返回后按创建流程轮询。有效票不能重跑。已有技术尝试保存在本机审计表。

请求无正文。

成功响应 `200`

```json
{
  "ok": true
}
```

### POST /api/questions/:id/outcome

仅在 `decided` 时受理。`correctAnswer` 可选 `是`、`否`、`说不清`，`note` 可省略。同一问题再次提交会更新事后记录及时间，统计随之更新。

请求正文

```json
{
  "correctAnswer": "是",
  "note": "已核对账单"
}
```

成功响应 `200`

```json
{
  "ok": true
}
```

### GET /api/stats

请求无正文。只计入已有确定事后答案且该方票有效的问题。`accuracy` 为 0–1，`avgConfidence` 为 50–100，两者最多保留两位小数。空样本返回 `null`。`calibration` 每档同时给出实际正确率与平均置信度，区间左右端点均包含。

```json
{
  "voters": [
    {
      "voter": "user", "judged": 1, "correct": 1, "accuracy": 1, "avgConfidence": 65,
      "calibration": [
        {"min":50,"max":59,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":60,"max":69,"judged":1,"correct":1,"accuracy":1,"avgConfidence":65},
        {"min":70,"max":79,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":80,"max":89,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":90,"max":100,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null}
      ]
    },
    {
      "voter": "gpt", "judged": 1, "correct": 1, "accuracy": 1, "avgConfidence": 72,
      "calibration": [
        {"min":50,"max":59,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":60,"max":69,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":70,"max":79,"judged":1,"correct":1,"accuracy":1,"avgConfidence":72},
        {"min":80,"max":89,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":90,"max":100,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null}
      ]
    },
    {
      "voter": "deepseek", "judged": 0, "correct": 0, "accuracy": null, "avgConfidence": null,
      "calibration": [
        {"min":50,"max":59,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":60,"max":69,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":70,"max":79,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":80,"max":89,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null},
        {"min":90,"max":100,"judged":0,"correct":0,"accuracy":null,"avgConfidence":null}
      ]
    }
  ]
}
```

## 错误码

统一结构见下例。倾向词在顶层 `warnings`，重复提交的原问题 ID 在顶层 `existingId`。

```json
{
  "error": {
    "code": "INVALID_STATE",
    "message": "当前表决状态不允许此操作。"
  }
}
```

| HTTP | `error.code` | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` | JSON 或 HTTP 请求格式不合法 |
| 401 | `UNAUTHENTICATED` | 缺少有效会话，或绝对／闲置时限已到 |
| 403 | `ORIGIN_DENIED` | 非 GET 请求缺少预期 Origin 或来源不同 |
| 403 | `INVALID_INVITE` | 邀请缺失、过期、已用，或与来源 IP、注册挑战不匹配 |
| 403 | `INVALID_CHALLENGE` | 挑战 cookie 缺失、已用、类型不符或已过期 |
| 403 | `VERIFICATION_FAILED` | 凭证、用户标识、签名、用户验证、origin 或 RP 验证失败 |
| 403 | `COUNTER_REJECTED` | 签名计数器回退或未递增。新旧均为 0 的同步凭证可用 |
| 404 | `NOT_FOUND` | 接口、问题、凭证或指定风险不存在 |
| 409 | `CREDENTIAL_EXISTS` | 凭证已经注册 |
| 409 | `LAST_CREDENTIAL` | 尝试删除最后一个凭证 |
| 409 | `INVALID_STATE` | 当前状态不允许所请求操作 |
| 409 | `DUPLICATE_QUESTION` | 相同问题材料已经锁定，使用 `existingId` |
| 413 | `PAYLOAD_TOO_LARGE` | 请求正文超过 256 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 请求正文媒体类型不受支持 |
| 422 | `INVALID_INPUT` | 字段、分页、父问题、确认答案或枚举无效 |
| 422 | `LINT_WARNINGS` | 需本人确认背景中的倾向词 |
| 429 | `RATE_LIMITED` | 认证接口达到限流阈值 |
| 500 | `INTERNAL_ERROR` | 服务未能完成请求 |

缺席模型的 `votes[].error` 独立于 HTTP 错误码。`TIMEOUT` 表示超时，`NETWORK` 表示连接失败，`INVALID_JSON` 和 `INVALID_SCHEMA` 表示无法验票，`WEB_SOURCES_UNVERIFIED` 表示联网票缺少可核对的引用，`INCOMPLETE` 表示供应商未完整返回，`PROVIDER_ERROR` 表示供应商错误，`PROVIDER_REJECTED` 表示供应商拒绝该请求，`INTERRUPTED` 表示派发后本机进程中断。除明确拒绝与进程中断外，均先自动重试一次。原文、供应商状态码、用量及尝试明细仅在本机数据库中可查。

## 对施工方案第 7 节的补充

接口路径、方法、创建成功状态和字段命名沿用施工方案。重复的创建请求补充 `409` 和 `existingId`。方案未指定成功正文的操作统一返回 `200 {"ok":true}`。详情补充 `decidedAt`、`nextStatus`、`finalNote`，统计补充 `calibration`。倾向词确认、平票时采纳模型的原因、分页上限、事后记录覆盖和空统计值按本文约定。

正式页面的 `/setup?token=…` 由 SPA 处理。非 API 的 GET 路径优先返回 `web/dist` 中的文件，缺失则回退到其 `index.html`。未放入正式构建时，`/`、`/setup` 和 `/dev.html` 提供临时测试页。
