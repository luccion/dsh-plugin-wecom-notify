# 推送到 GitHub

仓库已经在本地初始化好（`main` 分支 + `v0.1.0` 标签 + remote）。只要在 GitHub 上建一个**空的**
同名仓库，然后：

```bash
cd "C:\Users\lucci\Documents\deepseek-harness\default-workspace\plugins\wecom-turn-notify"
git push -u origin main
git push origin v0.1.0
```

第一次 `push` 会弹出 Git Credential Manager 让你登录 GitHub（本机没有 `gh`，ssh 到 github.com
也还没授权，所以走 HTTPS + GCM）。

## 建仓库时

- 名字：`dsh-plugin-wecom-notify`
- 可见性：**Public**
- **不要**勾选 “Add a README / .gitignore / license”——仓库必须为空，否则首次 push 会冲突。

## 不想用弹窗登录

把 `C:\Users\lucci\.ssh\lunch.pub` 加到 GitHub（Settings → SSH and GPG keys），然后：

```bash
git remote set-url origin git@github.com:luccion/dsh-plugin-wecom-notify.git
ssh -T git@github.com
git push -u origin main && git push origin v0.1.0
```

## push 之后自检

- 仓库首页 README 正常渲染，安装命令里的路径是 `luccion/dsh-plugin-wecom-notify`。
- Actions 页跑出绿色的 `test`（23 项断言）。
- 在另一台机器上按 README 装一遍：`git clone` → `pnpm install` → `dsh plugin install "$(pwd)"`。

这份文件是给你看的操作说明，可以随时删掉；它不参与插件运行。