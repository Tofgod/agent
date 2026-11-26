import { PROJECT_FOLDERS } from "./project-layout";

export function renderAgentPrompt(resultFollowup = false) {
  const directories = PROJECT_FOLDERS.map(({ path, purpose }) => path + " 存放" + purpose).join("\n");
  return [
    "项目目录用途\n" + directories,
    "按用户本轮要求工作。文字创作完成后告知结果和文件位置，结束本轮，等待用户下一条消息再继续制作图片、视频或成片。",
    ...(resultFollowup ? ["本轮由后台任务结果触发。若没有新的用户要求，报告任务状态和产物位置后结束本轮，等待用户下一条消息。"] : []),
  ].join("\n\n");
}
