"use client";
import React, { useEffect } from "react";
import { motion, useCycle } from "framer-motion";

const Child = () => {
  return (
    <Big purple>
      <Small purple />
    </Big>
  );
};

const Sibling = () => {
  return (
    <>
      <Big />
      <Small />
    </>
  );
};

const Example = () => {
  const [isOn, toggleOn] = useCycle(false, true);

  useEffect(() => {
    const timer = setTimeout(() => toggleOn(), 1000);
    return () => clearTimeout(timer);
  }, [isOn, toggleOn]);

  return (
    <div
      style={{
        width: "200px",
        height: "340px",
        overflow: "visible",
        backgroundColor: "#f3f3f3",
        borderRadius: "20px",
        position: "relative",
      }}
    >
      {isOn ? <Child /> : <Sibling />}
    </div>
  );
};

export default Example;

const Small = ({ purple = false }: { purple?: boolean }) => (
  <motion.div
    layoutId="small"
    id="small"
    key="small"
    style={{
      width: "60px",
      height: "60px",
      backgroundColor: "cyan",
      overflow: "visible",
      position: "absolute",
      top: purple ? "30px" : "172px",
      left: purple ? "30px" : "172px",
    }}
  >
    Small
  </motion.div>
);

const Big = ({
  purple = false,
  children,
}: {
  purple?: boolean;
  children?: React.ReactNode;
}) => (
  <motion.div
    layoutId="big"
    id="big"
    key="big"
    style={{
      width: purple ? "120px" : "60px",
      height: "60px",
      backgroundColor: "orange",
      overflow: "visible",
      position: "absolute",
      top: purple ? "137px" : "110px",
      left: purple ? "26px" : "40px",
    }}
  >
    {children}
  </motion.div>
);
