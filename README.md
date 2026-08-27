# dsh-idle-scheduler

deepseek-harness (dsh) 面板的**闲时任务调度**插件：把任务排队，在非高峰时段批量执行，并支持按任务选择模型。

- 任务队列：把待办任务排队，按配置的策略执行
- 闲时窗口：避开高峰（支持节假日/工作日等时间窗口）统一起跑
- 每任务模型选择：不同任务可指定不同模型
- 侧边栏提供「**闲时 / 定时**」按钮，一键投入队列

## 安装（DSH 一键命令）

在 dsh 面板所在的机器上，进入任意 dsh profile 后执行：

```bash
dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler
```

> 如需锁定版本：`dsh plugin --profile web add github:kevon2019/dsh-idle-scheduler@1.0.0`
> 安装后重启面板服务即可生效：`systemctl restart deepseek-harness.service`

## 配置

打开 dsh 面板 → **设置 → 闲时任务**：

- 启用/停用任务调度
- 设定闲时时间窗口与批量执行策略
- 为任务指定默认模型

侧边栏的「闲时 / 定时」按钮用于把当前/后台任务快速投入调度队列。

## 开发与源码

- 结构：`lib/index.js`（host 半）+ `lib/client.js`（client 半）+ `cordis.patch.yml`（bundle 挂载）
- 版本：`1.0.0`
- 许可：MIT
