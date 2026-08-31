ALTER TABLE knowledge_assets
  ADD COLUMN binary_data LONGBLOB NULL COMMENT '图片资产原始二进制内容' AFTER description;
