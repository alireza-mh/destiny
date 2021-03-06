import path from "path";

import logger from "../../shared/logger";
import { Graph } from "./shared/Graph";
import { findSharedParent } from "./shared/findSharedParent";
import { hasCycle } from "./toFractalTree/hasCycle";
import { isTestFile } from "./shared/isTestFile";
import { RootOption } from "../shared/RootOption";

export function toFractalTree(graph: Graph, entryPoints: string[]) {
  const tree: RootOption["tree"] = {};
  const treeSet = new Set<string>();
  const dependencies: Record<string, string[]> = {};
  const testFiles = new Set<string>();
  let containsCycle = false;

  const addDependency = (key: string, location: string) => {
    if (!Array.isArray(dependencies[key])) {
      dependencies[key] = [];
    }

    dependencies[key].push(location);
  };

  const checkDuplicates = (
    location: string,
    dirname: string,
    filePath: string
  ) => {
    const hasLocation = treeSet.has(location);

    if (hasLocation) {
      const newLocation = path.join(dirname, filePath.replace(/\//g, "-"));
      logger.info(`File renamed: ${filePath} -> ${newLocation}`);

      return newLocation;
    }

    return location;
  };

  const changeImportLocation = (
    filePath: string,
    newLocation: string
  ): void => {
    tree[filePath] = newLocation;

    treeSet.add(newLocation);
  };

  const fn = (filePath: string, folderPath: string, graph: Graph) => {
    const basename = path.basename(filePath);

    if (isTestFile(basename)) {
      testFiles.add(filePath);
      return;
    }

    let directoryName = path.basename(filePath, path.extname(filePath));
    const currentFolder = path.basename(path.dirname(filePath));
    const isGlobal = filePath.includes("..");

    const tempLocation = isGlobal
      ? filePath
      : path.join(
          folderPath,
          directoryName === "index" && currentFolder && currentFolder !== "."
            ? currentFolder + path.extname(filePath)
            : basename
        );

    const location = checkDuplicates(tempLocation, folderPath, filePath);
    directoryName = path.basename(location, path.extname(location));

    if (!isGlobal) {
      changeImportLocation(filePath, location);
    }

    const imports = graph[filePath];

    if (imports?.length > 0) {
      const newDestination = path.join(folderPath, directoryName);

      for (const importFilePath of imports) {
        // if importFilePath includes .. then it's a global
        // we don't store globals in tree, so check if cycle
        if (importFilePath in tree || importFilePath.includes("..")) {
          const cycle = hasCycle(importFilePath, graph, new Set());

          if (cycle) {
            containsCycle = true;
            logger.warn(`Dependency cycle detected: ${cycle.join(" -> ")}`);
          } else {
            addDependency(importFilePath, location);
          }
          continue;
        }

        addDependency(importFilePath, location);
        fn(importFilePath, newDestination, graph);
      }
    }
  };

  for (const filePath of entryPoints) {
    fn(filePath, "", graph);
  }

  if (!containsCycle) {
    Object.entries(dependencies).forEach(([currentPath, dependencies]) => {
      if (dependencies.length <= 1 || currentPath.includes("..")) {
        return;
      }

      const parent = findSharedParent(dependencies);
      const filename = path.basename(currentPath);
      const currentDir = path.dirname(currentPath);

      const newFilePath = path.join(
        parent,
        "shared",
        path.basename(filename, path.extname(filename)) === "index" &&
          currentDir &&
          currentDir !== "."
          ? path.join(currentDir + path.extname(filename))
          : filename
      );

      changeImportLocation(currentPath, newFilePath);
    });
  }

  if (testFiles.size > 0) {
    const globalTests = [];

    for (const testFile of testFiles) {
      const [firstRelativeImport] = graph[testFile];
      if (!firstRelativeImport) {
        globalTests.push(testFile);
        continue;
      }

      const testFilePath = tree[firstRelativeImport];

      if (!testFilePath) continue;

      const location = checkDuplicates(
        path.join(path.dirname(testFilePath), path.basename(testFile)),
        path.dirname(testFilePath),
        testFile
      );

      changeImportLocation(testFile, location);
    }
  }

  return tree;
}
