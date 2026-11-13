import { toaster } from "@/components/ui/toaster";

export const useGameToast = () => {
  const toastError = (title: string, message: string) => {
    toaster.create({
      title: title,
      duration: 6000,
      description: message,
      type: "error",
      closable: true,
    });
  };

  const toastInfo = (title: string, message?: string) => {
    toaster.create({
      title: title,
      duration: 3000,
      description: message,
      type: "info",
      closable: true,
    });
  };

  const toastOk = (title: string, message?: string) => {
    toaster.create({
      title: title,
      duration: 3000,
      description: message,
      type: "success",
      closable: true,
    });
  };

  return { toastError, toastInfo, toastOk };
};
