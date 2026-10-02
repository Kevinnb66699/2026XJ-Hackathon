// qrcode 没有自带类型，只声明用到的部分
declare module 'qrcode' {
  export function toDataURL(text: string, opts?: { margin?: number; width?: number }): Promise<string>
}
